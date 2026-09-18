import { choice, noul, score } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { JevContractError } from "../src/types.js";
import { validateAnswers } from "../src/validate.js";

const questions = {
  cat: choice("Which category applies to this item?", { a: null, b: null, other: null }),
  urg: score("How urgent is this item overall?", ["low", "mid", "high"]),
  flag: noul("Does this item need review?"),
};

const good = {
  cat: { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.8, b: 0.1, other: 0.1 } },
  urg: { type: "score", score: 1.2, confidence: 0.6, probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 } },
  flag: { type: "noul", noul: 0.3 },
};

describe("validateAnswers", () => {
  it("accepts a well-formed response", () => {
    expect(() => validateAnswers(questions, good)).not.toThrow();
  });

  it("rejects a choice outside the declared criteria", () => {
    // This is the case the type system CANNOT catch: the SDK casts the response body
    // instead of validating it, so a vendor change would otherwise flow straight into
    // `decide` typed as a label it is not.
    const bad = { ...good, cat: { ...good.cat, choice: "c", probabilities: { c: 1 } } };
    expect(() => validateAnswers(questions, bad)).toThrow(JevContractError);
  });

  it("rejects probabilities that do not sum to 1", () => {
    const bad = { ...good, cat: { ...good.cat, probabilities: { a: 0.2, b: 0.1, other: 0.1 } } };
    expect(() => validateAnswers(questions, bad)).toThrow(/sum to/);
  });

  it("rejects a score outside the rubric range", () => {
    const bad = { ...good, urg: { ...good.urg, score: 7 } };
    expect(() => validateAnswers(questions, bad)).toThrow(/outside \[0, 2]/);
  });

  it("rejects missing probability keys", () => {
    const bad = { ...good, urg: { ...good.urg, probabilities: { "0": 0.5, "1": 0.5 } } };
    expect(() => validateAnswers(questions, bad)).toThrow(/do not match/);
  });

  it("rejects a noul outside [0,1]", () => {
    expect(() => validateAnswers(questions, { ...good, flag: { type: "noul", noul: 1.4 } })).toThrow(/expected a number in \[0,1]/);
  });

  it("rejects a missing answer", () => {
    const { flag, ...rest } = good;
    expect(() => validateAnswers(questions, rest)).toThrow(/no answer for question "flag"/);
  });

  it("rejects an unexpected extra answer", () => {
    expect(() => validateAnswers(questions, { ...good, ghost: { type: "noul", noul: 0.5 } })).toThrow(/does not correspond/);
  });

  it("rejects a type mismatch", () => {
    expect(() => validateAnswers(questions, { ...good, flag: good.cat })).toThrow(/expected "noul"/);
  });
});
