/**
 * Core types for a Jev-backed decision.
 *
 * Everything here is generic over `Q extends Questions` so that the SDK's literal-type
 * inference survives. See `decision.ts` for why that matters and how it is protected.
 */
import type { EntryType, Questions, SystemOneResult } from "@typesafe-ai/sdk";

/**
 * The answers map for a question set, with each answer's type derived from its question.
 * Reuses the SDK's own `ResultFor` mapping rather than re-deriving it, so we stay correct
 * if the SDK's type mapping changes.
 */
export type Answers<Q extends Questions> = SystemOneResult<Q>["answers"];

/** Which band a decision landed in. Computed in OUR code, never by the model. */
export type Band = "act" | "review" | "escalate";

/**
 * Confidence cutoffs. Code-owned by design: TypeSafe ships no threshold configuration,
 * and that is correct -- the right cutoff depends on your data and on what a wrong
 * answer costs you, neither of which the vendor knows.
 *
 * Derive these from an eval report on your own labeled data. Never from a blog post.
 */
export interface Thresholds {
  /** At or above this confidence, act automatically. */
  readonly act: number;
  /** At or above this (but below `act`), route to a human for confirmation. */
  readonly review: number;
}

/**
 * How to turn an answer into a single confidence number.
 *
 * - `"top-probability"` (default): the probability mass on the selected outcome. Has a
 *   plain reading -- if the model is calibrated, it is P(this answer is correct).
 * - `"reported"`: the API's own `confidence` field. Not available for `noul`.
 *
 * These are not guaranteed to be the same number. The OpenAPI text calls `confidence`
 * "confidence in the selected choice"; TypeSafe's SKILL.md calls it "distribution
 * concentration". Which is better calibrated is UNVERIFIED and likely per-domain, so the
 * eval harness scores both and the report tells you which to use.
 */
export type ConfidenceMode = "top-probability" | "reported";

/** Why a decision fell back to deterministic code instead of using Jev's answer. */
export type FallbackReason =
  | "rate-limited"
  | "timeout"
  | "connection"
  | "server-error"
  | "deadline-exceeded"
  | "circuit-open"
  | "aborted";

/** Per-call accounting and provenance. Every field here exists to make a later question answerable. */
export interface Meta {
  readonly decision: string;
  readonly version: number;
  /** sha256 of the decision's semantic content. Catches "forgot to bump version". */
  readonly fingerprint: string;
  /** What we asked for -- possibly the `jev-latest` alias. */
  readonly requestedModel: string;
  /** What actually answered. Differs from `requestedModel` when an alias resolves. */
  readonly resolvedModel?: string;
  /** `x-typesafe-request-id`. Quote this to TypeSafe support. */
  readonly requestId?: string;
  readonly confidence?: number;
  readonly latencyMs: number;
  readonly usage?: { readonly input_tokens: number; readonly output_tokens: number };
  /** Undefined unless JEV_PRICE_PER_M_INPUT_USD is set -- the public price is UNVERIFIED. */
  readonly estimatedCostUsd?: number;
}

/**
 * The result of running a decision, as a discriminated union.
 *
 * There is deliberately no `outcome` on the union root. You cannot read an outcome
 * without first narrowing on `kind`, which means you cannot accidentally auto-act on a
 * low-confidence answer -- the type system makes the band impossible to ignore.
 */
export type DecisionResult<Q extends Questions, O> =
  | { readonly kind: "acted"; readonly band: "act"; readonly outcome: O; readonly answers: Answers<Q>; readonly meta: Meta }
  /** Provisional: `outcome` is safe to PRE-FILL a UI with, not to commit. */
  | { readonly kind: "review"; readonly band: "review"; readonly outcome: O; readonly answers: Answers<Q>; readonly meta: Meta }
  | { readonly kind: "escalated"; readonly band: "escalate"; readonly outcome: O; readonly escalated: true; readonly answers: Answers<Q>; readonly meta: Meta }
  | { readonly kind: "fallback"; readonly reason: FallbackReason; readonly outcome: O; readonly error: unknown; readonly meta: Meta }
  /** Jev was unavailable and the decision defined no fallback. Nothing was decided. */
  | { readonly kind: "failed"; readonly reason: FallbackReason; readonly error: unknown; readonly meta: Meta };

/**
 * Handles the `escalate` band: hand off to a human queue, or to a slower/smarter model.
 *
 * Deliberately NOT part of the Jev call path -- escalation is your policy, and an LLM
 * escalator belongs in your application, not in this library.
 */
export interface Escalator<Q extends Questions, S extends EntryType, O> {
  readonly name: string;
  escalate(input: { readonly state: S; readonly answers: Answers<Q>; readonly provisional: O; readonly meta: Meta }): Promise<O>;
}

/** The vendor returned something that does not match the contract. Never silently tolerated. */
export class JevContractError extends Error {
  override readonly name = "JevContractError";
  constructor(message: string, readonly detail?: unknown) {
    super(message);
  }
}

/** A decision was defined incorrectly. Thrown at definition time, not call time. */
export class JevDefinitionError extends Error {
  override readonly name = "JevDefinitionError";
}
