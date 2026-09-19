/**
 * An LLM-backed escalator: the seam where Jev hands off to a model that can reason.
 *
 * This lives in `examples/` rather than `src/` deliberately. The moment the core library
 * imports a text-model SDK it stops being a Jev integration and starts being a framework
 * with opinions about your other vendor too. Copy this file into your app and own it.
 *
 * The design point worth internalising: Jev's `escalate` band is NOT a failure path. It is
 * the set of cases where a cheap classifier honestly reported that it does not know, which
 * is exactly the set worth spending 1000x more on. TypeSafe's own guidance says the same
 * thing -- "send uncertain or failing cases to a person or reasoning model."
 */
import Anthropic from "@anthropic-ai/sdk";
import type { EntryType, Questions } from "@typesafe-ai/sdk";
import type { Answers, Escalator, Meta } from "../src/index.js";

/** Per-1M-token prices, for the accounting in the demo. Source: Claude API pricing. */
export const LLM_PRICING = {
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
} as const;

export type LlmModel = keyof typeof LLM_PRICING;

export interface LlmEscalatorOptions<O> {
  /**
   * Default `claude-opus-5`. A triage escalation is a plausible place to spend less --
   * but that is your call to make against your own eval, not a default this file makes
   * for you. Swap to `claude-haiku-4-5` and re-run the harness to see the real tradeoff.
   */
  readonly model?: LlmModel;
  /** JSON Schema the model must conform to. Same shape your `decide` returns. */
  readonly schema: Record<string, unknown>;
  /** Turn the state + Jev's answers into a prompt. Give the model what Jev could not use. */
  readonly prompt: (input: { state: unknown; answers: unknown; provisional: O }) => string;
  readonly system?: string;
  /** Called with real token usage so the harness can do honest cost accounting. */
  readonly onUsage?: (u: { model: string; input: number; output: number; costUsd: number; latencyMs: number; simulated: boolean }) => void;
}

/**
 * Escalate to Claude, constrained to the same output type the Jev path produces.
 *
 * Structured outputs (`output_config.format`) is what makes this substitutable: the LLM
 * must return the same shape `decide()` returns, so the caller's code does not branch on
 * which engine answered. Jev guarantees that shape structurally; here we ask for it.
 */
export function llmEscalator<Q extends Questions, S extends EntryType, O>(
  options: LlmEscalatorOptions<O>,
): Escalator<Q, S, O> {
  const model = options.model ?? "claude-opus-5";
  const hasCredentials =
    Boolean(process.env["ANTHROPIC_API_KEY"]) || Boolean(process.env["ANTHROPIC_AUTH_TOKEN"]);

  return {
    name: `llm:${model}`,
    escalate: async ({ state, answers, provisional, meta }) => {
      const prompt = options.prompt({ state, answers, provisional });
      const started = Date.now();

      if (!hasCredentials) {
        return simulate(prompt, provisional, model, started, options.onUsage);
      }

      const client = new Anthropic();
      try {
        const response = await client.messages.create({
          model,
          max_tokens: 1024,
          // Triage is a classification-shaped task; low effort is the right default here.
          // Raise it if your eval shows headroom -- do not guess.
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: options.schema },
          },
          ...(options.system === undefined ? {} : { system: options.system }),
          messages: [{ role: "user", content: prompt }],
        });

        options.onUsage?.({
          model: response.model,
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
          costUsd: costOf(model, response.usage.input_tokens, response.usage.output_tokens),
          latencyMs: Date.now() - started,
          simulated: false,
        });

        // A refusal is not a parse failure. Fall back to Jev's provisional answer rather
        // than throwing away the request.
        if (response.stop_reason === "refusal") return provisional;

        const text = response.content.find((b) => b.type === "text");
        return text === undefined ? provisional : (JSON.parse(text.text) as O);
      } catch (error) {
        // Most specific first. An escalation failing should degrade to Jev's provisional
        // answer, never take down the request -- the whole point is that Jev already
        // produced something usable.
        if (error instanceof Anthropic.RateLimitError) return provisional;
        if (error instanceof Anthropic.APIError) return provisional;
        throw error;
      }
    },
  };
}

export function costOf(model: LlmModel, inputTokens: number, outputTokens: number): number {
  const price = LLM_PRICING[model];
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

/**
 * Stand-in used when no credentials are present, so the demo runs anywhere.
 * Token counts are estimated from prompt length; latency is a plausible figure, not a
 * measurement. Everything it produces is flagged `simulated: true` and the report says so.
 */
function simulate<O>(
  prompt: string,
  provisional: O,
  model: LlmModel,
  started: number,
  onUsage: LlmEscalatorOptions<O>["onUsage"],
): Promise<O> {
  const input = Math.ceil(prompt.length / 4);
  const output = 90;
  onUsage?.({
    model: `${model} (simulated)`,
    input,
    output,
    costUsd: costOf(model, input, output),
    latencyMs: Date.now() - started + 3_400,
    simulated: true,
  });
  return Promise.resolve(provisional);
}
