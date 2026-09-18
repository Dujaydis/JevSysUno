/**
 * The smallest useful program: define, run, branch on the band.
 *
 *   npx tsx examples/basic.ts
 *
 * Runs against the offline simulator so it works with no API key. Swap the client for
 * `createJevClient()` once you have one.
 */
import { ticketTriage } from "../decisions/ticket-triage/decision.js";
import { createJevClient, Ledger, runDecision } from "../src/index.js";
import { simulatorFetch } from "../src/eval/simulator.js";

const client = createJevClient({
  apiKey: "simulated",
  fetch: simulatorFetch({ datasetPath: "decisions/ticket-triage/labeled.jsonl" }),
});

const ledger = new Ledger();

const ticket = {
  subject: "Charged twice this month",
  body: "I see two charges of $49 on my card for August. I only have one account. Please fix this ASAP.",
} as const;

const result = await runDecision(ticketTriage, ticket, { client, ledger });

// The switch is exhaustive. Add a band and the compiler tells you where to handle it.
switch (result.kind) {
  case "acted":
    console.log(`AUTO  ${result.outcome.category} / urgency ${result.outcome.urgency}`);
    break;
  case "review":
    console.log(`REVIEW (provisional: ${result.outcome.category}) — a human confirms this`);
    break;
  case "escalated":
    console.log(`ESCALATE — confidence ${result.meta.confidence?.toFixed(2)} is below the review floor`);
    break;
  case "fallback":
    console.log(`FALLBACK (${result.reason}) — deterministic rules produced ${result.outcome.category}`);
    break;
  case "failed":
    console.error(`FAILED (${result.reason}) — no fallback is defined for this decision`);
    break;
}

console.log("\nmeta:", {
  requested: result.meta.requestedModel,
  resolved: result.meta.resolvedModel,
  confidence: result.meta.confidence,
  latencyMs: result.meta.latencyMs,
  tokens: result.meta.usage?.input_tokens,
  // undefined unless you supply a price -- the public figure is unverified
  costUsd: result.meta.estimatedCostUsd,
});
console.log("ledger:", ledger.summary());
