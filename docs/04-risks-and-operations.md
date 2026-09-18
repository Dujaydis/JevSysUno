# Operational risks — read before you commit a roadmap to this

## Maturity

Jev launched **2026-09-15**. This dossier is from **2026-09-18**. That is a three-day-old
product. There are no named production customers, no disclosed scale, no outage history and
no pricing-change history — and the absence of bad history at three days old is not evidence
of stability, it is just absence of history.

The team pedigree is genuinely strong: CEO Diogo Almeida is ex-OpenAI and a co-inventor of
the RLHF/instruction-following work behind ChatGPT; $40M seed led by DCVC. That is a reason
to take the company seriously. It is not a reason to skip the eval harness.

## Lock-in

- **Closed weights. API-only.** No open-weight release, no self-hosting, no on-prem, no VPC
  deployment announced.
- Single vendor, single region. There is no second provider serving the same interface, so
  "switch providers" is not a mitigation available to you — the migration path off Jev is
  *rewriting the decision layer*, not changing a base URL.
- **Mitigation that actually works:** keep your question definitions, thresholds and policy
  in your own code as data (which the architecture in this repo does), so the vendor-specific
  part is only the transport. And build the cheap local baseline first — a logistic
  regression over a handful of signals costs an afternoon and tells you whether you need
  Jev's calibration at all.

## Data governance

All `state` you send leaves your infrastructure for TypeSafe's hosted API. Since there is no
on-prem option, **there is no configuration that keeps sensitive data in your perimeter.**
A privacy policy page exists at `typesafe.ai/legal/privacy-policy` but could not be read from
this environment — its retention and training-use terms are **unverified**. Read it yourself
before sending anything regulated, and assume for now that PII in `state` is PII sent to a
third party.

Practical control: redact/tokenize in code *before* building `state`. Jev cannot retrieve
anything, so it only ever sees exactly what you hand it — that is a real privacy lever.

## Availability

- **No SLA identified** during early access.
- Rate limits reported second-hand as 250,000 tokens/sec and 1,200 req/min, "adjusting
  dynamically without notice" — **unverified and explicitly volatile**. Handle 429s as a
  normal operating condition, not an exception.
- Access is waitlist-gated at `console.typesafe.ai`. A no-waitlist route reportedly exists
  via Vercel's AI Gateway under model id `typesafe-ai/jev` — **unverified**.

## The alias trap

`jev-latest` is an **alias**, and an alias moves when a new version ships. Your answers can
change without any change on your side — including your calibration, which you measured
against a model that is no longer what you're calling.

**Pin the model version in production**, and treat a version bump as a change that re-runs
the eval harness. Pin your question-schema version alongside it: a question's meaning and
the model answering it are a matched pair, and only makes sense evaluated together.

## Failure modes to design for

| Failure | Design response |
|---|---|
| 429 / rate limited | SDK retries twice; beyond that, queue or shed to the deterministic fallback |
| Timeout (10s/attempt, no total budget) | Set an explicit end-to-end deadline yourself |
| Service down | Deterministic fallback path — never let a judgment layer take the whole feature down |
| Low confidence | Escalate to human or LLM. This is a *normal* outcome, not an error |
| Confidently wrong | Only defensible answer is domain eval + human review band + outcome logging |
| Alias moved under you | Pinned version + eval re-run on bump |

## When not to use Jev at all

- You need an explanation, rationale, or citation shown to a user. It cannot produce one.
- The task is rule-expressible. Write the rule — a regex beat Jev on the phishing task.
- The decision is multi-hop. It reasons in one step.
- The answer space is open-ended or not known in advance.
- Your existing margin threshold already works. If calibration isn't your bottleneck, this
  adds a vendor for nothing.
- The state doesn't fit, or the model would need to retrieve something. It cannot retrieve.
