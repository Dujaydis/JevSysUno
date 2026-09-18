/**
 * `runDecision` -- call Jev, check the contract, pick a band, and return a result the
 * caller cannot misread.
 *
 * The sequence is deliberate:
 *   1. breaker check      -- don't pay latency to rediscover an outage
 *   2. call with deadline -- the SDK's timeout is per attempt, not total
 *   3. validate           -- the JS SDK does not check response bodies
 *   4. confidence + band  -- our policy, our thresholds
 *   5. decide / escalate  -- your pure function, or your escalation hook
 *
 * Steps 3 and 4 are the ones you would skip if you were in a hurry, and they are the two
 * that make the difference between "typed" and "trustworthy".
 */
import type { EntryType, Questions, TypeSafeClient } from "@typesafe-ai/sdk";
import { bandFor } from "./bands.js";
import { CircuitBreaker } from "./breaker.js";
import { primaryConfidence } from "./confidence.js";
import type { Decision } from "./decision.js";
import { DEFAULT_MODEL } from "./decision.js";
import { classifyError, JevCircuitOpenError, JevDeadlineError } from "./errors.js";
import type { Answers, DecisionResult, Escalator, FallbackReason, Meta } from "./types.js";
import { validateAnswers } from "./validate.js";
import { estimateCostUsd, Ledger } from "./usage.js";

export interface RunOptions<Q extends Questions, S extends EntryType, O> {
  readonly client: TypeSafeClient;
  /** Total wall-clock budget across all retries. Default 12000ms. */
  readonly deadlineMs?: number;
  readonly escalator?: Escalator<Q, S, O>;
  readonly breaker?: CircuitBreaker;
  readonly ledger?: Ledger;
  readonly signal?: AbortSignal;
  /** Price per 1M input tokens. UNVERIFIED publicly -- supply your own or get `undefined`. */
  readonly pricePerMillionUsd?: number;
}

export async function runDecision<Q extends Questions, S extends EntryType, O>(
  decision: Decision<Q, S, O>,
  state: S,
  options: RunOptions<Q, S, O>,
): Promise<DecisionResult<Q, O>> {
  const { client, escalator, breaker, ledger } = options;
  const deadlineMs = options.deadlineMs ?? 12_000;
  const requestedModel = decision.model ?? DEFAULT_MODEL;
  const started = Date.now();

  const baseMeta = {
    decision: decision.name,
    version: decision.version,
    fingerprint: decision.fingerprint,
    requestedModel,
  } as const;

  const finish = (result: DecisionResult<Q, O>): DecisionResult<Q, O> => {
    ledger?.record(result.meta, result.kind, "band" in result ? result.band : undefined);
    return result;
  };

  const degrade = (reason: FallbackReason, error: unknown): DecisionResult<Q, O> => {
    const meta: Meta = { ...baseMeta, latencyMs: Date.now() - started };
    if (decision.fallback) {
      return finish({ kind: "fallback", reason, outcome: decision.fallback(state, reason), error, meta });
    }
    return finish({ kind: "failed", reason, error, meta });
  };

  if (breaker?.isOpen) {
    return degrade("circuit-open", new JevCircuitOpenError(`circuit open for decision "${decision.name}"`));
  }

  let answers: Answers<Q>;
  let meta: Meta;
  try {
    const { data, requestId } = await withDeadline(
      (signal) => client.systemOne(decision.toRequest(state), { signal }).withResponse(),
      deadlineMs,
      options.signal,
    );

    breaker?.recordSuccess();

    // The SDK casts the response body rather than validating it. This is the check.
    validateAnswers(decision.questions, data.answers);
    answers = data.answers as Answers<Q>;

    const confidence = primaryConfidence(answers, decision.primary, decision.confidence ?? "top-probability");
    const cost = estimateCostUsd(data.usage.input_tokens, options.pricePerMillionUsd);
    meta = {
      ...baseMeta,
      resolvedModel: data.model,
      confidence,
      latencyMs: Date.now() - started,
      usage: data.usage,
      ...(requestId === undefined ? {} : { requestId }),
      ...(cost === undefined ? {} : { estimatedCostUsd: cost }),
    };
  } catch (error) {
    const reason = classifyError(error);
    if (reason === null) throw error; // config or contract bug -- never hide it behind a fallback
    breaker?.recordFailure();
    return degrade(reason, error);
  }

  const band = bandFor(meta.confidence ?? 0, decision.thresholds);
  const provisional = decision.decide(answers, state);

  if (band === "act") return finish({ kind: "acted", band, outcome: provisional, answers, meta });
  if (band === "review") return finish({ kind: "review", band, outcome: provisional, answers, meta });

  const outcome = escalator
    ? await escalator.escalate({ state, answers, provisional, meta })
    : provisional;
  return finish({ kind: "escalated", band, outcome, escalated: true, answers, meta });
}

/**
 * Enforce a total wall-clock budget.
 *
 * This RACES rather than only signalling abort, and the distinction matters: the SDK's own
 * `timeout` is per attempt with, in its own words, "no total retry budget", so with retries
 * and a 60s `Retry-After` cap one logical call can occupy well over a minute. Signalling
 * abort alone would leave that guarantee at the mercy of the transport honouring the
 * signal -- a custom `fetch` that ignores it would hang forever. Racing makes the bound
 * unconditional.
 *
 * We still abort the controller so a well-behaved transport can release its socket; we
 * just no longer depend on it doing so. The in-flight request may outlive this function,
 * which is the accepted cost of a hard deadline.
 */
async function withDeadline<T>(
  call: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  caller?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new JevDeadlineError(deadlineMs);
      controller.abort(error);
      reject(error);
    }, deadlineMs);
  });

  try {
    return await Promise.race([call(controller.signal), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
  }
}
