/**
 * Runtime validation of answers against the questions that produced them.
 *
 * Why this exists: the JavaScript SDK does NOT validate response bodies. Its `parseBody`
 * returns `parsed as T` -- a cast, not a check. (The Python SDK validates via pydantic;
 * the JS one trusts the wire.) So every type guarantee in this codebase is, at runtime,
 * only as good as the vendor's output. This module is where that assumption gets checked.
 *
 * A violation throws `JevContractError` and is deliberately NOT a fallback trigger: a
 * contract break means the vendor changed something under you, and silently degrading to
 * a regex would hide exactly the event you most need to see.
 */
import type { Question, Questions } from "@typesafe-ai/sdk";
import { JevContractError } from "./types.js";

/** Probabilities must sum to 1; allow for float noise and modest vendor rounding. */
const SUM_TOLERANCE = 0.02;

export function validateAnswers(questions: Questions, answers: unknown): void {
  if (answers === null || typeof answers !== "object") {
    throw new JevContractError("answers is not an object", answers);
  }
  const map = answers as Record<string, unknown>;

  for (const [name, question] of Object.entries(questions)) {
    const answer = map[name];
    if (answer === undefined) throw new JevContractError(`no answer for question "${name}"`, answers);
    validateOne(name, question, answer);
  }

  for (const name of Object.keys(map)) {
    if (!(name in questions)) {
      throw new JevContractError(`answer "${name}" does not correspond to any question asked`, map[name]);
    }
  }
}

function validateOne(name: string, question: Question, answer: unknown): void {
  if (answer === null || typeof answer !== "object") {
    throw new JevContractError(`answer "${name}" is not an object`, answer);
  }
  const a = answer as Record<string, unknown>;
  if (a["type"] !== question.type) {
    throw new JevContractError(`answer "${name}" has type "${String(a["type"])}", expected "${question.type}"`, answer);
  }

  switch (question.type) {
    case "noul": {
      assertUnit(name, "noul", a["noul"]);
      return;
    }
    case "choice": {
      const labels = Object.keys(question.criteria);
      const chosen = a["choice"];
      if (typeof chosen !== "string" || !labels.includes(chosen)) {
        throw new JevContractError(
          `answer "${name}" chose ${JSON.stringify(chosen)}, which is not one of the criteria [${labels.join(", ")}]`,
          answer,
        );
      }
      assertUnit(name, "confidence", a["confidence"]);
      assertDistribution(name, a["probabilities"], labels);
      return;
    }
    case "score": {
      const levels = question.criteria.length;
      const score = a["score"];
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > levels - 1) {
        throw new JevContractError(`answer "${name}" has score ${String(score)}, outside [0, ${levels - 1}]`, answer);
      }
      assertUnit(name, "confidence", a["confidence"]);
      // Wire keys are STRINGS ("0", "1", ...), not numbers. Never index these numerically.
      assertDistribution(name, a["probabilities"], Array.from({ length: levels }, (_, i) => String(i)));
      return;
    }
    default: {
      throw new JevContractError(`question "${name}" has an unrecognised type`, question);
    }
  }
}

function assertUnit(name: string, field: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new JevContractError(`answer "${name}" field "${field}" is ${String(value)}, expected a number in [0,1]`, value);
  }
}

function assertDistribution(name: string, value: unknown, expectedKeys: readonly string[]): void {
  if (value === null || typeof value !== "object") {
    throw new JevContractError(`answer "${name}" has no probabilities object`, value);
  }
  const probs = value as Record<string, unknown>;
  const actual = Object.keys(probs).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
    throw new JevContractError(
      `answer "${name}" probabilities keys [${actual.join(", ")}] do not match the expected [${expected.join(", ")}]`,
      value,
    );
  }
  let sum = 0;
  for (const key of actual) {
    const p = probs[key];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new JevContractError(`answer "${name}" probability for "${key}" is ${String(p)}, expected [0,1]`, value);
    }
    sum += p;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) {
    throw new JevContractError(`answer "${name}" probabilities sum to ${sum.toFixed(4)}, expected 1 +/- ${SUM_TOLERANCE}`, value);
  }
}
