/** Public surface. Application code should not need to import from deeper paths. */
export { assertThresholds, bandFor } from "./bands.js";
export { CircuitBreaker, type BreakerOptions } from "./breaker.js";
export { createJevClient, type JevClientOptions } from "./client.js";
export { concentration, confidenceOf, mostLikelyLevel, primaryConfidence } from "./confidence.js";
export { DEFAULT_MODEL, defineDecision, type Decision, type DecisionSpec } from "./decision.js";
export { classifyError, JevCircuitOpenError, JevDeadlineError } from "./errors.js";
export { noopEscalator, queueEscalator, type QueuedItem } from "./escalation.js";
export { canonicalJson, fingerprint } from "./fingerprint.js";
export { runDecision, type RunOptions } from "./run.js";
export {
  JevContractError,
  JevDefinitionError,
  type Answers,
  type Band,
  type ConfidenceMode,
  type DecisionResult,
  type Escalator,
  type FallbackReason,
  type Meta,
  type Thresholds,
} from "./types.js";
export { estimateCostUsd, Ledger, type UsageRecord } from "./usage.js";
export { validateAnswers } from "./validate.js";
