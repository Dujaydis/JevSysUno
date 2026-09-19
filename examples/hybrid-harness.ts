/**
 * A working Jev + LLM harness, end to end.
 *
 *   npx tsx examples/hybrid-harness.ts            # default thresholds
 *   npx tsx examples/hybrid-harness.ts --act=0.75 # loosen the auto-act band
 *   npx tsx examples/hybrid-harness.ts --model=claude-haiku-4-5
 *
 * The architecture: Jev decides, and its confidence decides who decides. High confidence
 * commits. Low confidence is handed to a reasoning model. The LLM never sees the 70-90%
 * of traffic Jev was sure about, and Jev never silently guesses on the part it wasn't.
 *
 * What this prints is the whole point -- the three-way tradeoff between cost, latency and
 * errors shipped, which moves as you move the threshold.
 */
import { loadJsonl } from "../src/eval/dataset.js";
import { simulatorFetch } from "../src/eval/simulator.js";
import { createJevClient, defineDecision, Ledger, mostLikelyLevel, runDecision } from "../src/index.js";
import { choice, noul, score } from "@typesafe-ai/sdk";
import type { Ticket, Triage } from "../decisions/ticket-triage/fallback.js";
import { triageWithRules } from "../decisions/ticket-triage/fallback.js";
import { costOf, llmEscalator, type LlmModel } from "./llm-escalator.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const raw = args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
const ACT = flag("act", 0.9);
const REVIEW = flag("review", 0.6);
const MODEL = (args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? "claude-opus-5") as LlmModel;

/** UNVERIFIED: the $0.042/M figure is not confirmable from any first-party TypeSafe source. */
const JEV_PRICE_PER_M = 0.042;

const decision = defineDecision<Ticket>()({
  name: "ticket-triage",
  version: 1,
  questions: {
    category: choice(
      "Which part of the product is this support ticket about? Judge by what the customer needs help with, not by which words appear.",
      {
        billing: "Charges, invoices, refunds, payment methods, pricing or subscription changes.",
        technical: "The product is malfunctioning: errors, crashes, incorrect behaviour or performance problems.",
        account: "Access to the account itself: sign-in, passwords, two-factor, permissions or seats.",
        other: "Anything else, including feature requests, general questions and messages that fit none of the above.",
      },
    ),
    urgency: score("How soon does this ticket need a human response, judged by business impact?", [
      "No time pressure.",
      "Answer in the next day or two.",
      "Needs an answer today.",
      "Needs an answer now; something is actively broken or money is at stake.",
    ]),
    refundRisk: noul("Is this customer likely to request a refund or cancel if this is not resolved well?"),
  },
  primary: "category",
  thresholds: { act: ACT, review: REVIEW },
  decide: (answers, _ticket): Triage => ({
    category: answers.category.choice,
    urgency: mostLikelyLevel(answers.urgency) as Triage["urgency"],
    needsHuman: answers.refundRisk.noul > 0.6 || mostLikelyLevel(answers.urgency) >= 3,
    source: "jev",
  }),
  fallback: (ticket) => triageWithRules(ticket),
});

const examples = loadJsonl<Ticket>("decisions/ticket-triage/labeled.jsonl");

let llmCalls = 0;
let llmCostUsd = 0;
let llmLatencyMs = 0;
let simulated = false;

const escalator = llmEscalator<typeof decision.questions, Ticket, Triage>({
  model: MODEL,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["category", "urgency", "needsHuman", "source"],
    properties: {
      category: { type: "string", enum: ["billing", "technical", "account", "other"] },
      urgency: { type: "integer", minimum: 0, maximum: 3 },
      needsHuman: { type: "boolean" },
      source: { type: "string", enum: ["llm"] },
    },
  },
  system:
    "You triage support tickets. A fast classifier already tried and was not confident. " +
    "Read the ticket and return the correct triage as JSON. Judge by what the customer needs, not by keywords.",
  prompt: ({ state, answers, provisional }) =>
    [
      `Ticket: ${JSON.stringify(state)}`,
      `The fast classifier's uncertain guess was: ${JSON.stringify(provisional)}`,
      `Its full probability distribution: ${JSON.stringify(answers)}`,
      "Return the correct triage.",
    ].join("\n\n"),
  onUsage: (u) => {
    llmCalls += 1;
    llmCostUsd += u.costUsd;
    llmLatencyMs += u.latencyMs;
    simulated = u.simulated;
  },
});

const client = createJevClient({
  apiKey: "simulated",
  fetch: simulatorFetch({ datasetPath: "decisions/ticket-triage/labeled.jsonl" }),
  retry: { maxRetries: 0 },
});

const ledger = new Ledger();
const rows: Array<{ id: string; band: string; expected: string; got: string; correct: boolean; viaLlm: boolean; confidence: number; tag: string }> = [];

for (const example of examples) {
  const result = await runDecision(decision, example.state, { client, ledger, escalator, pricePerMillionUsd: JEV_PRICE_PER_M });
  if (result.kind === "failed") continue;
  const viaLlm = result.kind === "escalated";
  rows.push({
    id: example.id,
    band: "band" in result ? result.band : "fallback",
    expected: example.expected,
    got: result.outcome.category,
    correct: result.outcome.category === example.expected,
    viaLlm,
    confidence: result.meta.confidence ?? 0,
    tag: example.tag,
  });
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------
const n = rows.length;
const acted = rows.filter((r) => r.band === "act");
const review = rows.filter((r) => r.band === "review");
const escalated = rows.filter((r) => r.band === "escalate");
const jev = ledger.summary();

// Errors that SHIP: mistakes in the auto-act band. A mistake in the review or escalate
// band gets caught downstream by a human or the LLM, so it costs money, not correctness.
const shippedErrors = acted.filter((r) => !r.correct).length;

// What the all-LLM baseline would have cost: every ticket through the model.
const perLlmCall = llmCalls > 0 ? llmCostUsd / llmCalls : costOf(MODEL, 320, 90);
const perLlmLatency = llmCalls > 0 ? llmLatencyMs / llmCalls : 3_400;
const allLlmCost = n * perLlmCall;
const allLlmLatency = n * perLlmLatency;

const hybridCost = (jev.costUsd ?? 0) + llmCostUsd;
const jevLatency = ledger.records.reduce((s, r) => s + r.latencyMs, 0);
const hybridLatency = jevLatency + llmLatencyMs;

// --dump emits per-ticket rows. Confidence does not depend on the thresholds, so one run
// gives every threshold's outcome -- a consumer can recompute any banding exactly.
if (args.includes("--dump")) {
  console.log(JSON.stringify(rows.map((r) => ({ id: r.id, tag: r.tag, confidence: +r.confidence.toFixed(4), correct: r.correct }))));
  process.exit(0);
}

// --json emits one line of machine-readable accounting, for sweeping thresholds.
if (args.includes("--json")) {
  console.log(
    JSON.stringify({
      actThreshold: ACT, reviewThreshold: REVIEW, model: MODEL, n, simulated,
      acted: acted.length, reviewed: review.length, escalated: escalated.length,
      shippedErrors, actBandErrorRate: acted.length === 0 ? 0 : shippedErrors / acted.length,
      jevCostUsd: jev.costUsd ?? 0, llmCostUsd, hybridCostUsd: hybridCost, allLlmCostUsd: allLlmCost,
      hybridLatencyMs: hybridLatency, allLlmLatencyMs: allLlmLatency, llmCalls,
    }),
  );
  process.exit(0);
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(6)}`;

console.log(`\n  HYBRID HARNESS -- ${n} tickets, thresholds { act: ${ACT}, review: ${REVIEW} }`);
if (simulated) {
  console.log("  Both legs simulated: no TypeSafe key and no ANTHROPIC_API_KEY in this environment.");
  console.log("  The routing logic and accounting are real; the model outputs are not.\n");
}

console.log("  ROUTING");
console.log(`    act       ${String(acted.length).padStart(3)}  ${pct(acted.length / n).padStart(6)}  committed automatically, no LLM`);
console.log(`    review    ${String(review.length).padStart(3)}  ${pct(review.length / n).padStart(6)}  provisional, queued for a human`);
console.log(`    escalate  ${String(escalated.length).padStart(3)}  ${pct(escalated.length / n).padStart(6)}  handed to ${MODEL}`);

console.log("\n  COST");
console.log(`    Jev        ${usd(jev.costUsd ?? 0)}  (${jev.inputTokens} input tokens, output free)`);
console.log(`    LLM        ${usd(llmCostUsd)}  (${llmCalls} call${llmCalls === 1 ? "" : "s"})`);
console.log(`    hybrid     ${usd(hybridCost)}`);
console.log(`    all-LLM    ${usd(allLlmCost)}   <- the baseline this replaces`);
console.log(`    saving     ${(allLlmCost / Math.max(hybridCost, 1e-12)).toFixed(1)}x cheaper`);

console.log("\n  LATENCY (total across all tickets)");
console.log(`    hybrid     ${(hybridLatency / 1000).toFixed(1)}s`);
console.log(`    all-LLM    ${(allLlmLatency / 1000).toFixed(1)}s`);
console.log(`    saving     ${(allLlmLatency / Math.max(hybridLatency, 1)).toFixed(1)}x faster`);

console.log("\n  WHAT IT COST YOU IN CORRECTNESS");
console.log(`    errors shipped unreviewed  ${shippedErrors} of ${acted.length} auto-acted (${pct(shippedErrors / Math.max(acted.length, 1))})`);
console.log(`    caught by a human or LLM   ${review.length + escalated.length}`);
console.log(
  "\n  This is the whole trade. Raise --act and more commits automatically: cheaper, faster,\n" +
    "  more errors shipped. Lower it and the LLM absorbs more: safer, slower, dearer. The\n" +
    "  threshold is the dial, and only your own labelled data says where to set it.\n",
);
