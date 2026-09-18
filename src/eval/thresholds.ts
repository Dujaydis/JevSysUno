/**
 * Deriving thresholds from measured data instead of guessing them.
 *
 * This function is the only legitimate source of the numbers in a `DecisionSpec`. It
 * refuses to answer on thin data rather than returning a confident number built on six
 * examples -- a threshold justified by a tiny sample is worse than an admitted guess,
 * because it looks earned.
 */
import type { Prediction, ReliabilityBin } from "./metrics.js";
import { reliabilityBins, wilsonInterval } from "./metrics.js";

export interface ThresholdSuggestion {
  readonly act?: number;
  readonly review?: number;
  readonly rationale: string;
  readonly bins: readonly ReliabilityBin[];
}

/**
 * Suggest an `act` cutoff as the lowest confidence bin whose accuracy is, at the LOWER
 * bound of its 95% interval, still above `targetAccuracy`.
 *
 * Using the lower bound rather than the point estimate is deliberate: a bin with 5/5
 * correct has a point estimate of 100% and a lower bound near 48%. Auto-acting on that is
 * how a pilot that looked perfect turns into an incident.
 */
export function suggestThresholds(
  predictions: readonly Prediction[],
  opts: { targetAccuracy?: number; minBinCount?: number; bins?: number } = {},
): ThresholdSuggestion {
  const target = opts.targetAccuracy ?? 0.95;
  const minCount = opts.minBinCount ?? 50;
  const bins = reliabilityBins(predictions, opts.bins ?? 10);

  if (predictions.length < minCount) {
    return {
      rationale:
        `Refusing to suggest thresholds: ${predictions.length} labeled examples is below the minimum of ${minCount}. ` +
        "Label more data -- especially ambiguous and adversarial cases, which is where accuracy collapses.",
      bins,
    };
  }

  let act: number | undefined;
  for (const bin of bins) {
    if (bin.count < minCount) continue;
    const interval = wilsonInterval(Math.round(bin.accuracy * bin.count), bin.count);
    if (interval.lo >= target) {
      act = bin.lo;
      break;
    }
  }

  // Review floor: the lowest bin that still beats a coin flip at its lower bound.
  let review: number | undefined;
  for (const bin of bins) {
    if (bin.count < minCount) continue;
    const interval = wilsonInterval(Math.round(bin.accuracy * bin.count), bin.count);
    if (interval.lo >= 0.5) {
      review = bin.lo;
      break;
    }
  }
  if (act !== undefined && review !== undefined && review >= act) review = undefined;

  const rationale =
    act === undefined
      ? `No confidence bin with at least ${minCount} examples reaches ${(target * 100).toFixed(0)}% accuracy at the ` +
        "lower bound of its 95% interval. On this data, nothing should auto-act. That is a finding, not a failure " +
        "of the harness -- route everything to review or reconsider whether Jev suits this decision."
      : `act >= ${act.toFixed(2)}: the lowest bin (n>=${minCount}) whose accuracy clears ${(target * 100).toFixed(0)}% ` +
        "at the LOWER bound of its 95% interval. The lower bound, not the point estimate, so a small lucky bin " +
        "cannot buy its way into auto-acting." +
        (review === undefined ? "" : ` review >= ${review.toFixed(2)}: the lowest bin that beats chance.`);

  return { ...(act === undefined ? {} : { act }), ...(review === undefined ? {} : { review }), rationale, bins };
}
