import { describe, it, expect } from "vitest";
import {
  wilsonInterval,
  accuracy,
  reliabilityBins,
  equalMassBins,
  ece,
  eceEqualMass,
  brierBinary,
  brierMulticlass,
  auroc,
  flipRate,
  meanAbsDrift,
  type Prediction,
} from "../src/eval/metrics.js";

describe("wilsonInterval", () => {
  it("bounds 8/10 successes and contains the observed rate 0.8", () => {
    // Hand-computed (z=1.96, phat=0.8, n=10):
    //   z2 = 3.8416
    //   denom = 1 + 3.8416/10 = 1.38416
    //   center = 0.8 + 3.8416/20 = 0.99208
    //   margin = 1.96 * sqrt(0.8*0.2/10 + 3.8416/400)
    //          = 1.96 * sqrt(0.016 + 0.009604) = 1.96 * sqrt(0.025604) ≈ 0.313625
    //   lo = (0.99208 - 0.313625) / 1.38416 ≈ 0.490157
    //   hi = (0.99208 + 0.313625) / 1.38416 ≈ 0.943319
    const { lo, hi } = wilsonInterval(8, 10);
    expect(lo).toBeCloseTo(0.490157, 4);
    expect(hi).toBeCloseTo(0.943319, 4);
    // Sanity: a real interval, and it must contain the point estimate 0.8.
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeLessThan(0.8);
    expect(hi).toBeGreaterThan(0.8);
  });

  it("does not NaN or throw for n=0, returning the maximally uncertain interval", () => {
    const { lo, hi } = wilsonInterval(0, 0);
    expect(Number.isNaN(lo)).toBe(false);
    expect(Number.isNaN(hi)).toBe(false);
    expect(lo).toBe(0);
    expect(hi).toBe(1);
  });

  it("handles 0 successes out of a positive n without going negative", () => {
    const { lo, hi } = wilsonInterval(0, 10);
    expect(lo).toBeCloseTo(0, 5);
    expect(hi).toBeCloseTo(0.27754, 4);
  });
});

describe("accuracy", () => {
  it("is the plain fraction correct", () => {
    const preds: Prediction[] = [
      { confidence: 0.9, correct: true },
      { confidence: 0.6, correct: true },
      { confidence: 0.4, correct: false },
      { confidence: 0.2, correct: false },
    ];
    expect(accuracy(preds)).toBeCloseTo(0.5, 10);
  });

  it("returns 0 for an empty input", () => {
    expect(accuracy([])).toBe(0);
  });
});

describe("reliabilityBins / ece (equal-width)", () => {
  // Hand-computed 2-bin toy: bin [0,0.5) gets the two 0.4-confidence preds
  // (1 correct, 1 wrong -> meanConfidence 0.4, accuracy 0.5, gap 0.1);
  // bin [0.5,1] gets the two 0.9-confidence preds (both correct ->
  // meanConfidence 0.9, accuracy 1.0, gap 0.1). ECE is the count-weighted
  // average gap: (2/4)*0.1 + (2/4)*0.1 = 0.1.
  const toy: Prediction[] = [
    { confidence: 0.4, correct: false },
    { confidence: 0.4, correct: true },
    { confidence: 0.9, correct: true },
    { confidence: 0.9, correct: true },
  ];

  it("bins the toy example as hand-computed", () => {
    const bins = reliabilityBins(toy, 2);
    expect(bins).toHaveLength(2);
    const bin0 = bins[0];
    const bin1 = bins[1];
    expect(bin0).toBeDefined();
    expect(bin1).toBeDefined();
    if (bin0 === undefined || bin1 === undefined) return;
    expect(bin0.lo).toBeCloseTo(0, 10);
    expect(bin0.hi).toBeCloseTo(0.5, 10);
    expect(bin0.count).toBe(2);
    expect(bin0.meanConfidence).toBeCloseTo(0.4, 10);
    expect(bin0.accuracy).toBeCloseTo(0.5, 10);
    expect(bin0.gap).toBeCloseTo(0.1, 10);

    expect(bin1.lo).toBeCloseTo(0.5, 10);
    expect(bin1.hi).toBeCloseTo(1, 10);
    expect(bin1.count).toBe(2);
    expect(bin1.meanConfidence).toBeCloseTo(0.9, 10);
    expect(bin1.accuracy).toBeCloseTo(1.0, 10);
    expect(bin1.gap).toBeCloseTo(0.1, 10);
  });

  it("computes ECE as the count-weighted mean gap", () => {
    expect(ece(toy, 2)).toBeCloseTo(0.1, 10);
  });

  it("produces `bins` buckets (all empty) for an empty input, never NaN", () => {
    const bins = reliabilityBins([], 10);
    expect(bins).toHaveLength(10);
    for (const bin of bins) {
      expect(bin.count).toBe(0);
      expect(bin.meanConfidence).toBe(0);
      expect(bin.accuracy).toBe(0);
      expect(bin.gap).toBe(0);
    }
  });

  it("ece returns 0 for an empty input", () => {
    expect(ece([])).toBe(0);
  });
});

describe("equalMassBins / eceEqualMass", () => {
  it("splits 10 items into 3 bins with (near-)equal counts (3,3,4)", () => {
    const confidences = [0.05, 0.12, 0.2, 0.28, 0.35, 0.44, 0.51, 0.63, 0.77, 0.89];
    const preds: Prediction[] = confidences.map((c) => ({ confidence: c, correct: true }));
    const bins = equalMassBins(preds, 3);
    expect(bins).toHaveLength(3);
    const counts = bins.map((b) => b.count);
    expect(counts).toEqual([3, 3, 4]);
    // Every bin actually got used, and counts sum back to the full input.
    expect(counts.reduce((a, b) => a + b, 0)).toBe(10);
    // No count differs from the "ideal" n/bins by more than 1.
    for (const c of counts) {
      expect(Math.abs(c - 10 / 3)).toBeLessThanOrEqual(1);
    }
  });

  it("returns [] for an empty input", () => {
    expect(equalMassBins([])).toEqual([]);
  });

  it("eceEqualMass returns 0 for an empty input", () => {
    expect(eceEqualMass([])).toBe(0);
  });
});

describe("brierBinary", () => {
  it("matches the hand value 0.01 for [{0.9,true},{0.1,false}]", () => {
    // (0.9 - 1)^2 = 0.01 ; (0.1 - 0)^2 = 0.01 ; mean = 0.01
    const preds: Prediction[] = [
      { confidence: 0.9, correct: true },
      { confidence: 0.1, correct: false },
    ];
    expect(brierBinary(preds)).toBeCloseTo(0.01, 10);
  });

  it("returns 0 for an empty input", () => {
    expect(brierBinary([])).toBe(0);
  });
});

describe("brierMulticlass", () => {
  it("matches the hand value 0.14 for one row", () => {
    // probabilities {a:0.7, b:0.2, c:0.1}, actual "a":
    // (0.7-1)^2 + (0.2-0)^2 + (0.1-0)^2 = 0.09 + 0.04 + 0.01 = 0.14
    const rows = [{ probabilities: { a: 0.7, b: 0.2, c: 0.1 }, actual: "a" }];
    expect(brierMulticlass(rows)).toBeCloseTo(0.14, 10);
  });

  it("scores rows where `actual` is absent from `probabilities` instead of throwing", () => {
    // probabilities {a:0.5, b:0.5}, actual "c" (not a key):
    // indicator is 0 for every listed key -> (0.5-0)^2 + (0.5-0)^2 = 0.5
    const rows = [{ probabilities: { a: 0.5, b: 0.5 }, actual: "c" }];
    expect(() => brierMulticlass(rows)).not.toThrow();
    expect(brierMulticlass(rows)).toBeCloseTo(0.5, 10);
  });

  it("returns 0 for an empty input", () => {
    expect(brierMulticlass([])).toBe(0);
  });
});

describe("auroc", () => {
  it("is exactly 1.0 when confidence perfectly separates correct from incorrect", () => {
    const preds: Prediction[] = [
      { confidence: 0.9, correct: true },
      { confidence: 0.8, correct: true },
      { confidence: 0.3, correct: false },
      { confidence: 0.1, correct: false },
    ];
    expect(auroc(preds)).toBeCloseTo(1.0, 10);
  });

  it("is exactly 0.0 when confidence is perfectly inverted", () => {
    const preds: Prediction[] = [
      { confidence: 0.9, correct: false },
      { confidence: 0.8, correct: false },
      { confidence: 0.3, correct: true },
      { confidence: 0.1, correct: true },
    ];
    expect(auroc(preds)).toBeCloseTo(0.0, 10);
  });

  it("is 0.5 when every prediction has the same confidence (all-ties)", () => {
    const preds: Prediction[] = [
      { confidence: 0.5, correct: true },
      { confidence: 0.5, correct: true },
      { confidence: 0.5, correct: false },
      { confidence: 0.5, correct: false },
    ];
    expect(auroc(preds)).toBeCloseTo(0.5, 10);
  });

  it("hand-computes a tie that spans both classes via mid-ranks (0.875)", () => {
    // confidences [0.9, 0.5, 0.5, 0.1], correct [true, true, false, false].
    // Positives: {0.9, 0.5}. Negatives: {0.5, 0.1}.
    // Sorted ascending: 0.1(neg, rank1), 0.5(pos, tie), 0.5(neg, tie), 0.9(pos, rank4).
    // The two 0.5s occupy ranks 2 and 3 -> mid-rank 2.5 each.
    // R1 (sum of positive ranks) = rank(0.9) + rank(0.5 pos) = 4 + 2.5 = 6.5
    // U1 = R1 - nPos*(nPos+1)/2 = 6.5 - 2*3/2 = 3.5
    // AUC = U1 / (nPos*nNeg) = 3.5 / 4 = 0.875
    // Cross-check via pair-counting (ties count as half a win):
    //   (0.9,0.5)->1, (0.9,0.1)->1, (0.5,0.5)->0.5, (0.5,0.1)->1 ; sum=3.5/4=0.875
    const preds: Prediction[] = [
      { confidence: 0.9, correct: true },
      { confidence: 0.5, correct: true },
      { confidence: 0.5, correct: false },
      { confidence: 0.1, correct: false },
    ];
    expect(auroc(preds)).toBeCloseTo(0.875, 10);
  });

  it("returns 0.5 (documented degenerate case) when every prediction is correct", () => {
    const preds: Prediction[] = [
      { confidence: 0.9, correct: true },
      { confidence: 0.8, correct: true },
      { confidence: 0.7, correct: true },
    ];
    expect(auroc(preds)).toBe(0.5);
  });

  it("returns 0.5 (documented degenerate case) when every prediction is incorrect", () => {
    const preds: Prediction[] = [
      { confidence: 0.9, correct: false },
      { confidence: 0.8, correct: false },
    ];
    expect(auroc(preds)).toBe(0.5);
  });

  it("returns 0.5 for an empty input", () => {
    expect(auroc([])).toBe(0.5);
  });
});

describe("flipRate", () => {
  it("is 0.25 for 3 runs of 4 items with exactly 1 item flipping", () => {
    const runs = [
      ["a", "b", "c", "d"],
      ["a", "b", "c", "d"],
      ["a", "x", "c", "d"], // item index 1 flips from "b" to "x"
    ];
    expect(flipRate(runs)).toBeCloseTo(0.25, 10);
  });

  it("is 0 when nothing flips across runs", () => {
    const runs = [
      ["a", "b"],
      ["a", "b"],
      ["a", "b"],
    ];
    expect(flipRate(runs)).toBe(0);
  });

  it("throws on ragged input (mismatched run lengths)", () => {
    const runs = [
      ["a", "b", "c"],
      ["a", "b"],
    ];
    expect(() => flipRate(runs)).toThrow(Error);
  });

  it("throws when fewer than 2 runs are given", () => {
    expect(() => flipRate([["a", "b"]])).toThrow(Error);
  });
});

describe("meanAbsDrift", () => {
  it("matches the hand value for a 3-run, 2-item example", () => {
    // item 0 across runs: [1, 2, 4] -> drift 4-1 = 3
    // item 1 across runs: [5, 5, 5] -> drift 5-5 = 0
    // mean = (3 + 0) / 2 = 1.5 ; max = 3
    const runs = [
      [1, 5],
      [2, 5],
      [4, 5],
    ];
    const { mean, max } = meanAbsDrift(runs);
    expect(mean).toBeCloseTo(1.5, 10);
    expect(max).toBeCloseTo(3, 10);
  });

  it("throws on ragged input (mismatched run lengths)", () => {
    const runs = [
      [1, 2, 3],
      [1, 2],
    ];
    expect(() => meanAbsDrift(runs)).toThrow(Error);
  });

  it("throws when fewer than 2 runs are given", () => {
    expect(() => meanAbsDrift([[1, 2]])).toThrow(Error);
  });

  it("returns {mean:0, max:0} when runs are all empty (zero items)", () => {
    const { mean, max } = meanAbsDrift([[], []]);
    expect(mean).toBe(0);
    expect(max).toBe(0);
  });
});
