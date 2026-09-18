/**
 * Type-level tests. These are checked by `tsc --noEmit`, not by the test runner -- if
 * inference breaks, the BUILD fails, which is the right blast radius for a regression
 * that would otherwise silently downgrade every label to `string`.
 *
 * The claim under test: passing questions through `defineDecision` does not widen them.
 * This is the entire argument for using Jev from TypeScript, so it is worth a guard.
 */
import { choice, noul, score } from "@typesafe-ai/sdk";
import { defineDecision } from "../../src/index.js";
import type { Answers } from "../../src/index.js";
import { ticketTriage } from "./decision.js";

/** Compile-time equality. Fails to compile if X and Y differ in either direction. */
type Exact<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const assertExact = <T extends true>(): T | void => undefined;

type Qs = typeof ticketTriage.questions;
type A = Answers<Qs>;

// 1. A choice answer is the literal union of the criteria keys -- not `string`.
assertExact<Exact<A["category"]["choice"], "billing" | "technical" | "account" | "other">>();

// 2. Score probability keys are the tuple indices AS STRINGS. Indexing with a number is
//    a type error, which is the guard against the wire-format mistake.
assertExact<Exact<keyof A["urgency"]["probabilities"], "0" | "1" | "2" | "3">>();

// 3. A noul answer carries only `noul` -- no confidence field exists to reach for.
assertExact<Exact<keyof A["refundRisk"], "type" | "noul">>();

// @ts-expect-error -- "biling" is a typo; the compiler must reject it.
const typo: A["category"]["choice"] = "biling";
void typo;

// @ts-expect-error -- level "4" is outside the four-level rubric.
type OutOfRange = A["urgency"]["probabilities"]["4"];

// @ts-expect-error -- a noul has no `confidence` field.
type NoNoulConfidence = A["refundRisk"]["confidence"];

/**
 * The anti-pattern guard: annotating the questions object as `Questions` widens every
 * label to `string`. Documented in decision.ts rule 1; asserted here so the rule is not
 * merely advice.
 */
const widened = defineDecision<{ readonly text: string }>()({
  name: "widened",
  version: 1,
  questions: { pick: choice("Pick one of these options for the given text.", { a: null, b: null, other: null }) },
  primary: "pick",
  thresholds: { act: 0.9, review: 0.6 },
  decide: (answers) => answers.pick.choice,
});
assertExact<Exact<ReturnType<typeof widened.decide>, "a" | "b" | "other">>();

/** `primary` must name a real question. */
defineDecision<{ readonly text: string }>()({
  name: "bad-primary",
  version: 1,
  questions: { flag: noul("Does this text need attention from a human reviewer?") },
  // @ts-expect-error -- "nope" is not a question in this decision.
  primary: "nope",
  thresholds: { act: 0.9, review: 0.6 },
  decide: (answers) => answers.flag.noul,
});

/** Score rubrics keep their arity, so a two-level rubric has exactly keys "0" | "1". */
const twoLevel = defineDecision<{ readonly text: string }>()({
  name: "two-level",
  version: 1,
  questions: { sev: score("How severe is the issue described in this text?", ["minor", "major"]) },
  primary: "sev",
  thresholds: { act: 0.9, review: 0.6 },
  decide: (answers) => answers.sev.probabilities,
});
assertExact<Exact<keyof ReturnType<typeof twoLevel.decide>, "0" | "1">>();

export type { OutOfRange, NoNoulConfidence };
