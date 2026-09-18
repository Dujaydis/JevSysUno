# What Jev / "System One" actually is

> Research snapshot: 2026-09-18. Jev was announced 2026-09-15, so this documents a
> product that was **three days old** at time of writing. Treat every number as a
> moving target and re-verify before relying on it.

## The one-paragraph version

Jev is TypeSafe AI's first "System One" model. It does **not** generate text. You send it
a blob of application state plus a set of *typed questions*, and it returns one typed
answer per question — a probability, a label from a set you defined, or a position on a
scale you defined — together with probability distributions. All questions in a request
are answered **in parallel and in isolation**. The name is a reference to Kahneman's
*Thinking, Fast and Slow*: System 1 is the fast, intuitive judgment you make without
deliberation.

## The mental model that matters

The most useful framing, and the one TypeSafe's CEO reportedly agreed with directly in
the launch-day Hacker News thread, is:

> **Jev is a very good zero-shot classifier with a typed interface.**

It is architecturally a **closed-set classification/scoring head**, not a language model
doing constrained decoding. There is no string being generated token-by-token and then
validated against a grammar — there is no string at all. You are, functionally, reading
probabilities off a fixed set of logits over an answer set you defined in advance.

Everything good and everything bad about Jev follows from that one fact.

## What follows from it — the good

- **It cannot emit an out-of-schema value.** Not "rarely does" — *cannot*. There is no
  code path that produces a label you did not define. No JSON parse step, no repair
  prompt, no retry-on-malformed-output.
- **It is fast.** One forward pass, not an autoregressive loop. Independent measurement:
  777 judgments (21 questions × 37 documents) returned in under 0.7 seconds.
- **It is cheap**, and adding questions to an existing request is nearly free in latency
  because they evaluate in parallel against the same state.
- **It returns a distribution, not just an answer** — which is what makes a real
  escalation path possible.

## What follows from it — the bad

- **A classifier can be confidently wrong.** The type guarantee covers the *shape* of the
  answer, never its *truth*. See `03-evidence-benchmarks.md`.
- **It cannot explain itself.** No rationale, no chain of thought, no citation. If your
  product needs to show a user *why*, Jev cannot supply it.
- **It reasons in one step.** Tasks needing "additional levels of indirection" — multi-hop
  inference — are outside its design.
- **It cannot retrieve.** Everything it needs must already be in the `state` you send.
- **Questions cannot see each other.** If question B depends on A's answer, that is two
  sequential requests, not one batch.

## The three primitives

| Need | Primitive | What comes back |
|---|---|---|
| Whether a condition holds | **Noul** | A single probability 0–1. **No separate confidence field** — the probability *is* the uncertainty. 0.5 means "genuinely torn", not "medium intensity". |
| One of a defined set | **Choice** | The winning label + a confidence + a probability for every label you defined. |
| Degree along a dimension | **Score** | A probability-weighted *expected value* (so it can be fractional, e.g. 1.7) + confidence + the full distribution over levels. |

"Noul" appears to be a portmanteau of "no" and "null". Some third-party wrappers rename
it "Boolean"; TypeSafe's own API calls it `noul`.

### The Score subtlety most people miss

`score` is **not** the most likely level. It is the *probability-weighted average* of the
levels. A score of `1.5` might mean "confidently between level 1 and 2", or it might mean
"a coin flip between level 0 and level 3". Those are completely different situations and
they produce the same number. **If the distinction matters to your logic, read
`probabilities`, not `score`.**

## What it is emphatically not for

Chat. Code generation. Drafting. Summarizing. Anything needing a written explanation.
TypeSafe says so themselves, and adds a specific warning that trying to assemble text by
chaining Choice calls "will not work well and will be very slow."
