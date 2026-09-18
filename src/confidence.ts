/**
 * Turning an answer into one confidence number.
 *
 * This lives in our code rather than being read off the wire because the three primitives
 * genuinely differ, and because `noul` has no confidence field at all -- by design, since
 * for a yes/no question the probability already IS the uncertainty.
 */
import type { Questions } from "@typesafe-ai/sdk";
import type { Answers, ConfidenceMode } from "./types.js";
import { JevContractError } from "./types.js";

/** Any answer shape, before narrowing. Kept loose on purpose: this runs after validation. */
type AnyAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

/**
 * Confidence in [0,1].
 *
 * | primitive | "top-probability" (default)   | "reported"        |
 * |-----------|-------------------------------|-------------------|
 * | noul      | max(p, 1-p) -- range [0.5,1]  | same (none exists)|
 * | choice    | probabilities[choice]         | `confidence`      |
 * | score     | max(probabilities[*])         | `confidence`      |
 *
 * Note the floor of 0.5 for `noul`: a yes/no question can never be less than 50% sure of
 * *something*, so a `review` threshold below 0.5 for a noul-driven decision is
 * meaningless. `defineDecision` rejects that.
 */
export function confidenceOf(answer: unknown, mode: ConfidenceMode = "top-probability"): number {
  const a = answer as AnyAnswer;
  switch (a.type) {
    case "noul":
      return Math.max(a.noul, 1 - a.noul);
    case "choice": {
      if (mode === "reported") return a.confidence;
      const p = a.probabilities[a.choice];
      if (p === undefined) {
        throw new JevContractError(`choice "${a.choice}" has no entry in probabilities`, a);
      }
      return p;
    }
    case "score": {
      if (mode === "reported") return a.confidence;
      const values = Object.values(a.probabilities);
      return values.length === 0 ? 0 : Math.max(...values);
    }
    default:
      throw new JevContractError("answer has an unrecognised type", answer);
  }
}

/** Confidence of the question that drives the band. */
export function primaryConfidence<Q extends Questions>(
  answers: Answers<Q>,
  primary: keyof Q & string,
  mode: ConfidenceMode = "top-probability",
): number {
  const answer = (answers as Record<string, unknown>)[primary];
  if (answer === undefined) {
    throw new JevContractError(`no answer returned for primary question "${primary}"`, answers);
  }
  return confidenceOf(answer, mode);
}

/**
 * The most likely rubric level for a `score` answer.
 *
 * Use this, NOT `Math.round(answer.score)`. `score` is a probability-weighted average, so
 * a bimodal distribution over levels 0 and 3 returns 1.5 -- a level the model considers
 * essentially impossible. Rounding that gives you 2, which it never predicted.
 */
export function mostLikelyLevel(answer: { probabilities: Record<string, number> }): number {
  let best = -1;
  let bestP = -1;
  for (const [key, p] of Object.entries(answer.probabilities)) {
    if (p > bestP) {
      bestP = p;
      best = Number(key);
    }
  }
  if (best < 0) throw new JevContractError("score answer has no probabilities", answer);
  return best;
}

/**
 * How concentrated a distribution is, as 1 - (normalised entropy), in [0,1].
 *
 * Useful for telling "confidently between two adjacent levels" apart from "torn between
 * two extremes" -- the two cases that produce the same `score` value.
 */
export function concentration(probabilities: Record<string, number>): number {
  const ps = Object.values(probabilities).filter((p) => p > 0);
  if (ps.length <= 1) return 1;
  const entropy = -ps.reduce((sum, p) => sum + p * Math.log(p), 0);
  return 1 - entropy / Math.log(ps.length);
}
