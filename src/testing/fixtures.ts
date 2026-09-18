/**
 * Record/replay fixtures, implemented as an SDK `Fetch`.
 *
 * The SDK accepts a custom `fetch`, so no HTTP-interception library is needed. Tests run
 * with no API key and no network, which matters more than usual here: Jev is in waitlisted
 * early access, so CI almost certainly cannot reach it.
 *
 * Fixture keys are a hash of the CANONICAL request body, which means changing a question's
 * wording changes the key and the old fixture stops matching. That is intended: a golden
 * test that keeps passing after you reworded the question is testing nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fetch } from "@typesafe-ai/sdk";
import { fingerprint } from "../fingerprint.js";

export type FixtureMode = "replay" | "record" | "auto";

export interface FixtureOptions {
  readonly dir: string;
  /**
   * - `replay`: never touch the network; a miss throws.
   * - `record`: always call the real API and write the result.
   * - `auto`:   replay on hit, record on miss (needs a key).
   */
  readonly mode?: FixtureMode;
  /** Used only in record/auto mode. */
  readonly realFetch?: Fetch;
}

export interface Fixture {
  readonly key: string;
  readonly recordedAt: string;
  /** True for hand-written fixtures never produced by the live API. Always disclose this. */
  readonly synthetic?: boolean;
  readonly request: unknown;
  readonly status: number;
  readonly body: unknown;
}

export function fixtureFetch(options: FixtureOptions): Fetch {
  const mode = options.mode ?? "replay";
  const realFetch = options.realFetch ?? globalThis.fetch;

  return async (input: string, init?: RequestInit): Promise<Response> => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const key = keyFor(input, bodyText);
    const path = join(options.dir, `${key}.json`);

    if (mode !== "record" && existsSync(path)) {
      const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
      return new Response(JSON.stringify(fixture.body), {
        status: fixture.status,
        headers: { "content-type": "application/json", "x-typesafe-request-id": `fixture-${key}` },
      });
    }

    if (mode === "replay") {
      throw new Error(
        `Fixture miss: ${key}\n  looked in: ${path}\n` +
          "  The request body does not match any recorded fixture. If you changed a question's wording or " +
          "criteria, that is expected -- re-record with mode: \"record\" and a real API key, and review the diff.",
      );
    }

    const response = await realFetch(input, init);
    const text = await response.text();
    mkdirSync(options.dir, { recursive: true });
    const fixture: Fixture = {
      key,
      recordedAt: new Date().toISOString(),
      request: safeParse(bodyText),
      status: response.status,
      body: safeParse(text),
    };
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
    return new Response(text, { status: response.status, headers: response.headers });
  };
}

function keyFor(url: string, body: string): string {
  const path = new URL(url, "https://api.typesafe.ai").pathname.replace(/\W+/g, "-").replace(/^-|-$/g, "");
  return `${path}-${fingerprint({ body: safeParse(body) })}`;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
