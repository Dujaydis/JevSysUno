/**
 * Client construction with our defaults.
 *
 * The SDK's own defaults are sensible, but two of them need an opinion applied:
 *   - `timeout` is PER ATTEMPT, with (quoting the SDK's own types) "no total retry
 *     budget". With maxRetries 2 and a 60s Retry-After cap, one call can occupy well over
 *     a minute. `runDecision` imposes an outer deadline; this is where the per-attempt
 *     number is kept modest so that deadline is reachable.
 *   - Browser use is refused by the SDK unless explicitly overridden. We never override
 *     it: an API key in a page is an API key in everyone's DevTools.
 */
import { TypeSafeClient, type TypeSafeClientConfig } from "@typesafe-ai/sdk";

export interface JevClientOptions extends TypeSafeClientConfig {
  /** Per-attempt timeout in ms. Default 8000, slightly under the SDK's 10s. */
  readonly attemptTimeoutMs?: number;
}

export function createJevClient(options: JevClientOptions = {}): TypeSafeClient {
  const { attemptTimeoutMs, ...rest } = options;
  return new TypeSafeClient({
    timeout: attemptTimeoutMs ?? 8_000,
    ...rest,
  });
}
