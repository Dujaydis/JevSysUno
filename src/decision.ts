/**
 * `defineDecision` -- the one abstraction application code touches.
 *
 * A Decision bundles the four things that must change together: the questions, the
 * confidence policy, the thresholds, and the pure function that turns answers into an
 * outcome. Versioning them as a unit is the point; a threshold tuned against one wording
 * of a question is meaningless against another.
 *
 * ## Keeping the compiler's knowledge (read this before editing)
 *
 * The SDK's `choice()` and `score()` builders use `const` type parameters, so
 * `answers.category.choice` is the literal union `"billing" | "technical" | "other"`
 * rather than `string`. That inference is the single biggest reason to use Jev from
 * TypeScript, and it is easy to destroy by accident. Four rules:
 *
 *   1. NEVER annotate the questions object as `Questions` or `Record<string, Question>`.
 *      That widens every label to `string`. `satisfies Questions` is fine.
 *   2. Build questions with the SDK's `noul()` / `choice()` / `score()` helpers, or as
 *      object literals written inline in the `defineDecision` call.
 *   3. Write `decide` inline in the same call so it is contextually typed. If you must
 *      extract it, type it as `(a: Answers<typeof questions>, s: S) => O`.
 *   4. Questions are code, not config. `JSON.parse`-ing them at runtime gives you back
 *      `string` and the compiler can no longer help you.
 *
 * `decisions/ticket-triage/decision.test-d.ts` asserts rule 1 still holds, so if a future
 * SDK version breaks it, a test fails rather than the types quietly going slack.
 */
import type { EntryType, Questions } from "@typesafe-ai/sdk";
import { assertThresholds } from "./bands.js";
import { fingerprint } from "./fingerprint.js";
import type { Answers, ConfidenceMode, FallbackReason, Thresholds } from "./types.js";
import { JevDefinitionError } from "./types.js";

export interface DecisionSpec<Q extends Questions, S extends EntryType, O> {
  /** Stable identifier, e.g. "ticket-triage". Used in fixtures, ledgers and reports. */
  readonly name: string;
  /** Bump on ANY change to questions, criteria, thresholds or model. */
  readonly version: number;
  /**
   * Pin a concrete model in production. Omitted means `jev-latest`, which is an ALIAS:
   * it moves when TypeSafe ships a new version, changing your answers and invalidating
   * your calibration with no change on your side.
   */
  readonly model?: string;
  /** Keep this a literal object -- see the inference rules above. */
  readonly questions: Q;
  /** Which answer's confidence drives the band. */
  readonly primary: keyof Q & string;
  readonly confidence?: ConfidenceMode;
  /**
   * Code-owned cutoffs. Ship these with a provenance comment naming the eval report,
   * date, resolved model and sample size they came from. A threshold without that
   * provenance is a guess wearing a number's clothes.
   */
  readonly thresholds: Thresholds;
  /** Pure. No I/O, no clock, no randomness -- so it is trivially testable and replayable. */
  readonly decide: (answers: Answers<Q>, state: S) => O;
  /** Deterministic, no network. Used when Jev is unavailable -- never when it is merely unsure. */
  readonly fallback?: (state: S, reason: FallbackReason) => O;
}

export interface Decision<Q extends Questions, S extends EntryType, O> extends DecisionSpec<Q, S, O> {
  /** sha256 over the decision's semantic content. Invalidates stale fixtures automatically. */
  readonly fingerprint: string;
  /** The exact request body that would be sent for this state. Handy in tests and logs. */
  toRequest(state: S): { state: S; model: string; questions: Q };
}

export const DEFAULT_MODEL = "jev-latest";

/**
 * Curried on purpose: `defineDecision<Ticket>()({ ... })`.
 *
 * TypeScript has no partial type-argument inference, so a single call cannot both take an
 * explicit state type AND infer `const Q` from the questions literal -- supply one and you
 * lose the other, and losing `Q` collapses every label to `string`, which is the whole
 * point of using Jev from TypeScript. The extra `()` buys: state annotated once, questions
 * inferred literally, and `decide`'s parameters contextually typed from both.
 *
 * `S` must be JSON-shaped (it is serialised into the request), so declare state with a
 * `type` alias rather than an `interface` -- only aliases get the implicit index signature
 * that satisfies the SDK's `EntryType`.
 */
export function defineDecision<S extends EntryType>() {
  return function define<const Q extends Questions, O>(spec: DecisionSpec<Q, S, O>): Decision<Q, S, O> {
    return build(spec);
  };
}

function build<Q extends Questions, S extends EntryType, O>(spec: DecisionSpec<Q, S, O>): Decision<Q, S, O> {
  const problems: string[] = [];

  const names = Object.keys(spec.questions);
  if (names.length === 0) problems.push("a decision needs at least one question");
  if (!names.includes(spec.primary)) {
    problems.push(`primary "${spec.primary}" is not one of the questions [${names.join(", ")}]`);
  }

  const primaryQuestion = spec.questions[spec.primary];
  problems.push(...assertThresholds(spec.thresholds, { noulFloor: primaryQuestion?.type === "noul" }));

  if (spec.confidence === "reported" && primaryQuestion?.type === "noul") {
    problems.push('confidence: "reported" is unavailable for a noul primary -- noul answers carry no confidence field');
  }

  for (const [name, q] of Object.entries(spec.questions)) {
    if (q.type === "score" && q.criteria.length < 2) {
      problems.push(`score question "${name}" needs at least two levels`);
    }
    if (q.type === "choice" && Object.keys(q.criteria).length < 2) {
      problems.push(`choice question "${name}" needs at least two labels`);
    }
  }

  if (problems.length > 0) {
    throw new JevDefinitionError(`decision "${spec.name}" is invalid:\n  - ${problems.join("\n  - ")}`);
  }

  warnOnSoftIssues(spec);

  const model = spec.model ?? DEFAULT_MODEL;
  return {
    ...spec,
    fingerprint: fingerprint({
      name: spec.name,
      version: spec.version,
      model,
      questions: spec.questions,
      thresholds: spec.thresholds,
      confidence: spec.confidence ?? "top-probability",
    }),
    toRequest: (state: S) => ({ state, model, questions: spec.questions }),
  };
}

/**
 * Advisory checks for things TypeSafe's own guidance warns about but which are not
 * errors. Warn, never throw: some choice sets really are exhaustive, and some questions
 * really are one word.
 */
function warnOnSoftIssues<Q extends Questions, S extends EntryType, O>(spec: DecisionSpec<Q, S, O>): void {
  if (process.env["NODE_ENV"] === "production") return;

  for (const [name, q] of Object.entries(spec.questions)) {
    // Question IDs are NOT sent to the model. A question named `isBilling` with empty
    // instructions gives the model nothing to go on.
    if (q.type !== "noul" && (typeof q.instructions !== "string" || q.instructions.trim().length < 20)) {
      console.warn(
        `[jev] decision "${spec.name}" question "${name}": instructions are very short. Question names are not ` +
          "sent to the model, so all meaning must be in `instructions`.",
      );
    }
    if (q.type === "choice") {
      const hasNoMatch = Object.keys(q.criteria).some((l) => /^(other|none|unclear|no[_-]?match|unknown)/i.test(l));
      if (!hasNoMatch) {
        console.warn(
          `[jev] decision "${spec.name}" question "${name}": no no-match label. The model must pick one of your ` +
            "labels even when none fits. Add an `other` unless the set is genuinely exhaustive.",
        );
      }
    }
  }

  if (!spec.model) {
    console.warn(
      `[jev] decision "${spec.name}" uses the "${DEFAULT_MODEL}" alias. Aliases move when a new version ships, ` +
        "which changes your answers and invalidates your calibration. Pin a concrete version for production.",
    );
  }
}
