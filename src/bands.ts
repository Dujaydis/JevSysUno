/**
 * The three-band pattern: act / review / escalate.
 *
 * This is the whole reason to prefer a model that returns a distribution over one that
 * returns a bare label. The thresholds live here, in code, because what a wrong answer
 * costs is a property of your product, not of the model.
 */
import type { Band, Thresholds } from "./types.js";

export function bandFor(confidence: number, t: Thresholds): Band {
  if (confidence >= t.act) return "act";
  if (confidence >= t.review) return "review";
  return "escalate";
}

/**
 * Validate thresholds at definition time so a nonsensical policy cannot reach production.
 *
 * `noulFloor` is set when the band-driving question is a `noul`, whose confidence is
 * `max(p, 1-p)` and therefore can never drop below 0.5 -- a review threshold under 0.5
 * would put literally nothing in the escalate band, which is almost certainly a mistake
 * rather than an intention.
 */
export function assertThresholds(t: Thresholds, opts: { noulFloor: boolean }): string[] {
  const problems: string[] = [];
  for (const [name, v] of [["act", t.act], ["review", t.review]] as const) {
    if (!Number.isFinite(v) || v <= 0 || v > 1) problems.push(`thresholds.${name} must be in (0,1], got ${v}`);
  }
  if (t.act <= t.review) problems.push(`thresholds.act (${t.act}) must be greater than thresholds.review (${t.review})`);
  if (opts.noulFloor && t.review < 0.5) {
    problems.push(
      `thresholds.review is ${t.review}, but a noul's confidence is max(p, 1-p) and can never be below 0.5. ` +
        "Nothing would ever escalate. Did you mean to threshold on the raw probability instead?",
    );
  }
  return problems;
}
