import { describe, expect, it } from "vitest";
import { assertThresholds, bandFor } from "../src/bands.js";

describe("bandFor", () => {
  const t = { act: 0.9, review: 0.6 };
  it("is inclusive at each boundary", () => {
    expect(bandFor(0.9, t)).toBe("act");
    expect(bandFor(0.6, t)).toBe("review");
  });
  it("routes below the boundaries downward", () => {
    expect(bandFor(0.8999, t)).toBe("review");
    expect(bandFor(0.5999, t)).toBe("escalate");
    expect(bandFor(0, t)).toBe("escalate");
  });
});

describe("assertThresholds", () => {
  it("accepts a sane policy", () => {
    expect(assertThresholds({ act: 0.9, review: 0.6 }, { noulFloor: false })).toEqual([]);
  });
  it("rejects act <= review", () => {
    expect(assertThresholds({ act: 0.5, review: 0.6 }, { noulFloor: false })[0]).toMatch(/must be greater/);
  });
  it("rejects out-of-range values", () => {
    expect(assertThresholds({ act: 1.5, review: 0.6 }, { noulFloor: false })[0]).toMatch(/must be in \(0,1]/);
  });
  it("catches a review threshold below the noul floor of 0.5", () => {
    // A noul's confidence is max(p, 1-p), so it can never be under 0.5 -- nothing
    // would ever land in the escalate band.
    const problems = assertThresholds({ act: 0.9, review: 0.3 }, { noulFloor: true });
    expect(problems.join(" ")).toMatch(/never be below 0\.5/);
  });
});
