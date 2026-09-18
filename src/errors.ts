/**
 * Mapping SDK errors onto "degrade gracefully" vs "fail loudly".
 *
 * The distinction that matters: a transient infrastructure problem should fall back to
 * deterministic code and keep the feature alive. A configuration or contract problem
 * should NOT -- if your API key is wrong, hiding that behind a regex fallback means you
 * discover it weeks later from a quality regression instead of immediately from an alarm.
 */
import {
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import type { FallbackReason } from "./types.js";

/** Thrown by `runDecision` when the outer deadline fires before the SDK gives up. */
export class JevDeadlineError extends Error {
  override readonly name = "JevDeadlineError";
  constructor(readonly deadlineMs: number) {
    super(
      `Jev call exceeded the ${deadlineMs}ms deadline. Note the SDK's own timeout is PER ATTEMPT with no total ` +
        "retry budget, so without this deadline a single call can occupy 30s+ of wall clock.",
    );
  }
}

/** The circuit breaker is open; we did not even attempt the call. */
export class JevCircuitOpenError extends Error {
  override readonly name = "JevCircuitOpenError";
}

/**
 * Returns a `FallbackReason` for transient failures, or `null` when the error should
 * propagate.
 *
 * Deliberately NOT in this table: low confidence. An unsure answer is a normal,
 * successful result that belongs in the `escalate` band -- not a failure, and never a
 * reason to substitute the deterministic fallback.
 */
export function classifyError(error: unknown): FallbackReason | null {
  if (error instanceof JevDeadlineError) return "deadline-exceeded";
  if (error instanceof JevCircuitOpenError) return "circuit-open";

  // Order matters: APITimeoutError extends APIConnectionError in the SDK.
  if (error instanceof APITimeoutError) return "timeout";
  if (error instanceof APIUserAbortError) return "aborted";
  if (error instanceof APIConnectionError) return "connection";
  if (error instanceof RateLimitError) return "rate-limited";
  if (error instanceof InternalServerError) return "server-error";

  // Your bug, not theirs. Let it surface.
  if (
    error instanceof BadRequestError ||
    error instanceof AuthenticationError ||
    error instanceof PermissionDeniedError ||
    error instanceof NotFoundError ||
    error instanceof UnprocessableEntityError
  ) {
    return null;
  }
  return null;
}
