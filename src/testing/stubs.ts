/** Canned `Fetch` implementations for exercising the failure paths. */
import type { Fetch } from "@typesafe-ai/sdk";

export function jsonResponse(body: unknown, status = 200): Fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-typesafe-request-id": "stub" },
      }),
    );
}

export function rateLimited(retryAfterMs = 50): Fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ detail: "slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after-ms": String(retryAfterMs) },
      }),
    );
}

export function serverError(): Fetch {
  return () => Promise.resolve(new Response(JSON.stringify({ detail: "boom" }), { status: 500, headers: { "content-type": "application/json" } }));
}

export function unauthorized(): Fetch {
  return () => Promise.resolve(new Response(JSON.stringify({ detail: "bad key" }), { status: 401, headers: { "content-type": "application/json" } }));
}

/**
 * Never resolves on its own, but honours `AbortSignal` the way a real `fetch` does.
 * Use with a short deadline to exercise the outer timeout.
 */
export function neverResolves(): Fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    });
}

/** Never resolves AND ignores abort entirely -- the pathological transport. */
export function hangsIgnoringAbort(): Fetch {
  return () => new Promise<Response>(() => {});
}
