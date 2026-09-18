import { describe, expect, it } from "vitest";
import { concentration, confidenceOf, mostLikelyLevel } from "../src/confidence.js";

describe("confidenceOf", () => {
  it("folds a noul around 0.5, so a confident NO is high confidence", () => {
    expect(confidenceOf({ type: "noul", noul: 0.02 })).toBeCloseTo(0.98, 10);
    expect(confidenceOf({ type: "noul", noul: 0.98 })).toBeCloseTo(0.98, 10);
    expect(confidenceOf({ type: "noul", noul: 0.5 })).toBeCloseTo(0.5, 10);
  });

  it("uses the selected label's probability by default, and the reported field on request", () => {
    const a = { type: "choice", choice: "a", confidence: 0.77, probabilities: { a: 0.6, b: 0.4 } };
    expect(confidenceOf(a)).toBeCloseTo(0.6, 10);
    expect(confidenceOf(a, "reported")).toBeCloseTo(0.77, 10);
  });

  it("uses the peak of the distribution for a score", () => {
    const a = { type: "score", score: 1.5, confidence: 0.4, probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 } };
    expect(confidenceOf(a)).toBeCloseTo(0.7, 10);
  });
});

describe("mostLikelyLevel vs rounding the score", () => {
  it("separates the two distributions that both report score 1.5", () => {
    // The trap: `score` is a probability-weighted average, not a bucket.
    const between = { probabilities: { "0": 0.02, "1": 0.48, "2": 0.48, "3": 0.02 } };
    const bimodal = { probabilities: { "0": 0.5, "1": 0.0, "2": 0.0, "3": 0.5 } };

    // Both have expected value 1.5, so Math.round(score) would give 2 for both.
    expect(mostLikelyLevel(between)).toBe(1);
    expect(mostLikelyLevel(bimodal)).toBe(0);

    // And concentration tells them apart: the bimodal case is maximally uncertain.
    expect(concentration(between.probabilities)).toBeGreaterThan(concentration(bimodal.probabilities));
    expect(concentration(bimodal.probabilities)).toBeCloseTo(0, 10);
  });
});
