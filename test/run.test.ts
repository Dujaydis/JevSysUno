import { AuthenticationError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { ticketTriage } from "../decisions/ticket-triage/decision.js";
import { CircuitBreaker } from "../src/breaker.js";
import { createJevClient } from "../src/client.js";
import { runDecision } from "../src/run.js";
import { hangsIgnoringAbort, jsonResponse, neverResolves, rateLimited, serverError, unauthorized } from "../src/testing/stubs.js";
import { JevContractError, type Band } from "../src/types.js";
import { Ledger } from "../src/usage.js";

const ticket = { subject: "Charged twice", body: "I see two charges of $49 for August. Please fix this ASAP." } as const;

/** A well-formed response whose category confidence we can dial to land in any band. */
function answersWithCategoryConfidence(p: number) {
  const rest = (1 - p) / 3;
  return {
    model: "jev-1.0",
    answers: {
      category: {
        type: "choice",
        choice: "billing",
        confidence: p,
        probabilities: { billing: p, technical: rest, account: rest, other: rest },
      },
      urgency: { type: "score", score: 2.1, confidence: 0.7, probabilities: { "0": 0.05, "1": 0.15, "2": 0.7, "3": 0.1 } },
      refundRisk: { type: "noul", noul: 0.82 },
    },
    usage: { input_tokens: 120, output_tokens: 6 },
  };
}

const clientWith = (fetch: ReturnType<typeof jsonResponse>) =>
  createJevClient({ apiKey: "test-key", fetch, retry: { maxRetries: 0 } });

describe("runDecision — bands", () => {
  it("acts on high confidence and exposes the outcome only after narrowing", async () => {
    const result = await runDecision(ticketTriage, ticket, { client: clientWith(jsonResponse(answersWithCategoryConfidence(0.96))) });
    expect(result.kind).toBe("acted");
    if (result.kind !== "acted") throw new Error("unreachable");
    expect(result.outcome.category).toBe("billing");
    // mostLikelyLevel, not Math.round(2.1)
    expect(result.outcome.urgency).toBe(2);
    expect(result.outcome.source).toBe("jev");
    expect(result.meta.resolvedModel).toBe("jev-1.0");
    expect(result.meta.confidence).toBeCloseTo(0.96, 6);
  });

  it("routes mid confidence to review", async () => {
    const result = await runDecision(ticketTriage, ticket, { client: clientWith(jsonResponse(answersWithCategoryConfidence(0.75))) });
    expect(result.kind).toBe("review");
  });

  it("escalates low confidence — and never calls the fallback for it", async () => {
    const result = await runDecision(ticketTriage, ticket, { client: clientWith(jsonResponse(answersWithCategoryConfidence(0.4))) });
    expect(result.kind).toBe("escalated");
    if (result.kind !== "escalated") throw new Error("unreachable");
    // Low confidence is a successful answer, not a failure. The fallback is for outages.
    expect(result.outcome.source).toBe("jev");
  });

  it("runs the escalator when one is supplied", async () => {
    let seen: Band | undefined;
    const result = await runDecision(ticketTriage, ticket, {
      client: clientWith(jsonResponse(answersWithCategoryConfidence(0.4))),
      escalator: {
        name: "test",
        escalate: ({ provisional, meta }) => {
          seen = meta.confidence !== undefined && meta.confidence < 0.6 ? "escalate" : "act";
          return Promise.resolve({ ...provisional, needsHuman: true });
        },
      },
    });
    expect(seen).toBe("escalate");
    if (result.kind !== "escalated") throw new Error("unreachable");
    expect(result.outcome.needsHuman).toBe(true);
  });
});

describe("runDecision — failure classification", () => {
  it("falls back on rate limiting", async () => {
    const result = await runDecision(ticketTriage, ticket, { client: clientWith(rateLimited()) });
    expect(result.kind).toBe("fallback");
    if (result.kind !== "fallback") throw new Error("unreachable");
    expect(result.reason).toBe("rate-limited");
    expect(result.outcome.source).toBe("fallback");
    expect(result.outcome.category).toBe("billing"); // the regex agrees here
  });

  it("falls back on a server error", async () => {
    const result = await runDecision(ticketTriage, ticket, { client: clientWith(serverError()) });
    if (result.kind !== "fallback") throw new Error("unreachable");
    expect(result.reason).toBe("server-error");
  });

  it("RETHROWS a bad API key instead of hiding it behind the fallback", async () => {
    // The whole point of the classification table: a config bug must not masquerade as a
    // degraded-but-working service, or you find out weeks later from a quality regression.
    await expect(runDecision(ticketTriage, ticket, { client: clientWith(unauthorized()) })).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("enforces an outer deadline, because the SDK timeout is per attempt", async () => {
    const result = await runDecision(ticketTriage, ticket, {
      client: createJevClient({ apiKey: "k", fetch: neverResolves(), retry: { maxRetries: 0 }, timeout: 60_000 }),
      deadlineMs: 150,
    });
    if (result.kind !== "fallback") throw new Error("unreachable");
    expect(result.reason).toBe("deadline-exceeded");
  });

  it("holds the deadline even against a transport that ignores AbortSignal", async () => {
    // The deadline races rather than merely signalling abort, so the wall-clock bound does
    // not depend on the transport co-operating. Without the race this test hangs forever.
    const started = Date.now();
    const result = await runDecision(ticketTriage, ticket, {
      client: createJevClient({ apiKey: "k", fetch: hangsIgnoringAbort(), retry: { maxRetries: 0 }, timeout: 60_000 }),
      deadlineMs: 150,
    });
    if (result.kind !== "fallback") throw new Error("unreachable");
    expect(result.reason).toBe("deadline-exceeded");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("propagates a caller abort", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await runDecision(ticketTriage, ticket, {
      client: createJevClient({ apiKey: "k", fetch: neverResolves(), retry: { maxRetries: 0 }, timeout: 60_000 }),
      deadlineMs: 5_000,
      signal: controller.signal,
    });
    if (result.kind !== "fallback") throw new Error("unreachable");
    expect(["aborted", "connection"]).toContain(result.reason);
  });

  it("opens the circuit after repeated failures and stops paying latency", async () => {
    const breaker = new CircuitBreaker({ threshold: 2, resetMs: 10_000 });
    const client = clientWith(serverError());
    await runDecision(ticketTriage, ticket, { client, breaker });
    await runDecision(ticketTriage, ticket, { client, breaker });
    const third = await runDecision(ticketTriage, ticket, { client, breaker });
    if (third.kind !== "fallback") throw new Error("unreachable");
    expect(third.reason).toBe("circuit-open");
  });
});

describe("runDecision — contract enforcement", () => {
  it("throws when the vendor returns a label outside the declared criteria", async () => {
    // The JS SDK casts the response body rather than validating it, so without this check
    // an unexpected label would reach `decide` typed as something it is not.
    const rogue = answersWithCategoryConfidence(0.95);
    const broken = { ...rogue, answers: { ...rogue.answers, category: { ...rogue.answers.category, choice: "refunds" } } };
    await expect(runDecision(ticketTriage, ticket, { client: clientWith(jsonResponse(broken)) })).rejects.toBeInstanceOf(JevContractError);
  });
});

describe("accounting", () => {
  it("records usage, the resolved model, and no cost when the price is unknown", async () => {
    const ledger = new Ledger();
    await runDecision(ticketTriage, ticket, { client: clientWith(jsonResponse(answersWithCategoryConfidence(0.96))), ledger });
    const summary = ledger.summary();
    expect(summary.calls).toBe(1);
    expect(summary.inputTokens).toBe(120);
    // Unset by design: the public per-token price is UNVERIFIED.
    expect(summary.costUsd).toBeUndefined();
    expect(summary.resolvedModels).toEqual(["jev-1.0"]);
  });

  it("estimates cost when a price is supplied explicitly", async () => {
    const ledger = new Ledger();
    await runDecision(ticketTriage, ticket, {
      client: clientWith(jsonResponse(answersWithCategoryConfidence(0.96))),
      ledger,
      pricePerMillionUsd: 0.042,
    });
    expect(ledger.summary().costUsd).toBeCloseTo((120 / 1_000_000) * 0.042, 12);
  });
});
