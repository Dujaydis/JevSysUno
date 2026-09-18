/**
 * Running a decision across a labeled dataset and scoring it.
 *
 * Scores the PRIMARY question only. Multi-question decisions need one eval per question
 * that gates behaviour; rolling them into a single number hides which one is failing.
 */
import type { EntryType, Questions, TypeSafeClient } from "@typesafe-ai/sdk";
import { confidenceOf, mostLikelyLevel } from "../confidence.js";
import type { Decision } from "../decision.js";
import { runDecision } from "../run.js";
import { Ledger } from "../usage.js";
import type { LabeledExample, Tag } from "./dataset.js";
import { flipRate, meanAbsDrift, type Prediction } from "./metrics.js";

export interface HarnessResult {
  readonly predictions: Prediction[];
  readonly byTag: Record<Tag, Prediction[]>;
  readonly resolvedModels: string[];
  readonly inputTokens: number;
  readonly costUsd?: number;
  readonly failures: number;
}

/** The label a `decide`-free, primary-only comparison should produce for one answer. */
function predictedLabel(answer: unknown): string {
  const a = answer as { type: string; choice?: string; noul?: number; probabilities?: Record<string, number> };
  if (a.type === "choice") return a.choice ?? "";
  if (a.type === "noul") return (a.noul ?? 0) >= 0.5 ? "true" : "false";
  if (a.type === "score" && a.probabilities) return String(mostLikelyLevel({ probabilities: a.probabilities }));
  return "";
}

export async function evaluate<Q extends Questions, S extends EntryType, O>(
  decision: Decision<Q, S, O>,
  examples: readonly LabeledExample<S>[],
  client: TypeSafeClient,
): Promise<HarnessResult> {
  const ledger = new Ledger();
  const predictions: Prediction[] = [];
  const byTag: Record<Tag, Prediction[]> = { clear: [], ambiguous: [], adversarial: [] };
  const models = new Set<string>();
  let failures = 0;

  for (const example of examples) {
    const result = await runDecision(decision, example.state, { client, ledger });
    if (result.kind === "failed" || result.kind === "fallback") {
      failures += 1;
      continue;
    }
    const answer = (result.answers as Record<string, unknown>)[decision.primary];
    const prediction: Prediction = {
      confidence: confidenceOf(answer, decision.confidence ?? "top-probability"),
      correct: predictedLabel(answer) === example.expected,
    };
    predictions.push(prediction);
    byTag[example.tag].push(prediction);
    if (result.meta.resolvedModel !== undefined) models.add(result.meta.resolvedModel);
  }

  const summary = ledger.summary();
  return {
    predictions,
    byTag,
    resolvedModels: [...models],
    inputTokens: summary.inputTokens,
    ...(summary.costUsd === undefined ? {} : { costUsd: summary.costUsd }),
    failures,
  };
}

/**
 * Re-run identical inputs to measure how much the answers move.
 *
 * Only meaningful against the live API -- replaying fixtures returns the same bytes and
 * would report a perfect 0% flip rate, which is a property of the fixture file, not the
 * model. The CLI refuses to report stability in replay mode for exactly that reason.
 */
export async function measureStability<Q extends Questions, S extends EntryType, O>(
  decision: Decision<Q, S, O>,
  examples: readonly LabeledExample<S>[],
  client: TypeSafeClient,
  repeats: number,
): Promise<{ flipRate: number; drift: { mean: number; max: number }; repeats: number }> {
  const labelRuns: string[][] = [];
  const confidenceRuns: number[][] = [];

  for (let r = 0; r < repeats; r += 1) {
    const labels: string[] = [];
    const confidences: number[] = [];
    for (const example of examples) {
      const result = await runDecision(decision, example.state, { client });
      if (result.kind === "failed" || result.kind === "fallback") {
        labels.push("<failed>");
        confidences.push(0);
        continue;
      }
      const answer = (result.answers as Record<string, unknown>)[decision.primary];
      labels.push(predictedLabel(answer));
      confidences.push(confidenceOf(answer, decision.confidence ?? "top-probability"));
    }
    labelRuns.push(labels);
    confidenceRuns.push(confidences);
  }

  return { flipRate: flipRate(labelRuns), drift: meanAbsDrift(confidenceRuns), repeats };
}
