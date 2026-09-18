# JevSysUno

A reference integration for **TypeSafe AI's Jev**, the first "System One" model: typed
decisions, thresholds that live in your code, and a calibration harness that tells you
whether to trust any of it.

> **Status:** researched and built 2026-09-18, three days after Jev's launch. No live API
> access was available, so nothing here has been run against the real model. The wire
> contract is taken from TypeSafe's official SDK source; the benchmark numbers are from
> independent third-party evaluations. See [`docs/00-sources-and-confidence.md`](docs/00-sources-and-confidence.md).

## What Jev is, in three sentences

It does not generate text. You send it application state plus a set of typed questions, and
it returns one typed answer each — a probability, a label from a set you defined, or a
position on a scale you defined — evaluated in parallel and in isolation. It is, precisely,
a very good zero-shot classifier with an interface that cannot produce an out-of-schema
value.

**[Start with the interactive explainer →](docs/jev-explainer.html)** (simple / medium /
detailed, with runnable demos of each primitive)

## Read this before you adopt it

Independent benchmarks published in Jev's launch week disagree with each other, and that
disagreement should shape your architecture:

| Benchmark | Result |
|---|---|
| Phishing, n=2000 | Jev **62.6%** vs Claude Haiku 4.5 **81.3%**. Worse calibrated (ECE 0.154 vs 0.097). A plain **regex scored 91.8%**, beating Jev's best question. |
| Tool-call risk, n=60 | Jev **91.7%** overall — but **100% clear / 71.4% ambiguous**. Calibration good: the 0.9–1.0 bin was 98% accurate. |
| Stability | **2.2%** of identical repeated inputs returned a different label. |

**Jev's edge is latency, cost, and an interface that cannot break — not accuracy.** No
number anywhere, including TypeSafe's own, shows it beating the models it is priced
against. Adopt it for the real reasons, and measure calibration on your own data before
anything auto-acts. That is what `npm run eval` is for.

## The five-minute path

```bash
npm install
npm test                                      # 65 tests, no API key needed
npm run eval -- decisions/ticket-triage       # simulated report, no API key needed
```

### 1. Define a decision

```ts
import { choice, noul, score } from "@typesafe-ai/sdk";
import { defineDecision, mostLikelyLevel } from "jevsysuno";

type Ticket = { readonly subject: string; readonly body: string };

export const ticketTriage = defineDecision<Ticket>()({
  name: "ticket-triage",
  version: 1,
  questions: {
    category: choice("Which part of the product is this ticket about? ...", {
      billing: "Charges, invoices, refunds, payment methods...",
      technical: "The product is malfunctioning...",
      account: "Access to the account itself...",
      other: "Anything else, including feature requests...",
    }),
    urgency: score("How soon does this need a human response? ...", [
      "No time pressure.",
      "Answer in the next day or two.",
      "Needs an answer today.",
      "Needs an answer now.",
    ]),
    refundRisk: noul("Is this customer likely to request a refund or cancel?"),
  },
  primary: "category",
  thresholds: { act: 0.9, review: 0.6 },   // derive these from an eval report
  decide: (answers, ticket) => ({
    category: answers.category.choice,     // typed "billing" | "technical" | "account" | "other"
    urgency: mostLikelyLevel(answers.urgency),
    needsHuman: answers.refundRisk.noul > 0.6,
  }),
  fallback: (ticket) => triageWithRules(ticket),
});
```

### 2. Run it

```ts
const result = await runDecision(ticketTriage, ticket, { client: createJevClient() });

switch (result.kind) {
  case "acted":     return commit(result.outcome);          // high confidence
  case "review":    return prefillForHuman(result.outcome); // provisional only
  case "escalated": return sendToQueue(result.outcome);     // low confidence
  case "fallback":  return commit(result.outcome);          // Jev was down; rules ran
  case "failed":    throw new Error("no fallback defined");
}
```

There is deliberately **no `result.outcome` on the union root**. You cannot read an outcome
without narrowing on `kind`, so you cannot accidentally auto-act on a low-confidence answer.

### 3. Measure before you trust

```bash
npm run eval -- decisions/ticket-triage --simulate=overconfident
```

The report breaks accuracy out by difficulty tag, computes ECE / Brier / AUROC / reliability
bins, compares Jev against your deterministic baseline, and **refuses to suggest thresholds
from fewer than 50 labeled examples**. Try both `--simulate` regimes: identical thresholds,
very different safety.

## Why it's built this way

Five decisions worth knowing about, each forced by something in the SDK source or the
evidence:

1. **`defineDecision<State>()({...})` is curried.** TypeScript has no partial type-argument
   inference — a single call cannot take an explicit state type *and* infer `const Q` from
   the questions literal. Losing `Q` collapses every label to `string`, which is the entire
   reason to use Jev from TypeScript. `decision.test-d.ts` asserts the inference survives,
   so a regression fails the build.
2. **Responses are validated at runtime.** The JS SDK's `parseBody` *casts* rather than
   validating (the Python SDK uses pydantic; the JS one trusts the wire). Without
   `validate.ts`, a vendor change flows straight into `decide` typed as something it isn't.
   A contract break throws — it never quietly degrades to the fallback.
3. **The deadline races, it doesn't just signal abort.** The SDK's `timeout` is *per
   attempt* with, in its own words, "no total retry budget", so one call can occupy 30s+.
   Racing makes the wall-clock bound hold even against a transport that ignores
   `AbortSignal`.
4. **Errors split into degrade-vs-fail.** Transient failures use the fallback; `401`/`422`
   rethrow, because a config bug that masquerades as a working-but-degraded service is
   discovered weeks later from a quality regression. **Low confidence is never a fallback
   reason** — it's a successful answer that belongs in the escalate band.
5. **Cost estimation returns `undefined` by default.** The widely-quoted $0.042/M input
   figure is not confirmable from any first-party source. A confident wrong number in a
   budget is worse than an admitted unknown.

## Layout

```
src/            the part you install
  decision.ts   defineDecision — the one abstraction app code touches
  run.ts        call → validate → band → decide/escalate/fallback
  validate.ts   runtime contract check the SDK doesn't do
  confidence.ts per-primitive confidence extraction
  bands.ts      act / review / escalate
  eval/         metrics, harness, report, CLI, offline simulator
  testing/      fixture record/replay + failure stubs
decisions/      the part you copy and edit
docs/           research dossier + the interactive explainer
```

## Before production

- [ ] **Pin the model.** `jev-latest` is an alias that moves when a new version ships,
      silently invalidating your calibration. Get a concrete name from `GET /v1/models`.
- [ ] **Replace the placeholder thresholds** with values from an eval report on your own
      labeled data, and keep the provenance comment.
- [ ] **Verify pricing, rate limits and privacy terms** at `typesafe.ai` — all unconfirmed
      here. See the checklist in `docs/00-sources-and-confidence.md`.
- [ ] **Check whether the baseline wins.** If `triageWithRules` matches Jev on your data,
      ship the rules and delete the API call.

## License

MIT.
