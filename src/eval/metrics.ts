/**
 * Calibration and stability metrics for evaluating a probabilistic classifier
 * (or an LLM-as-classifier, which is why this package exists).
 *
 * Pure math, zero dependencies. Every function here takes plain data in and
 * returns a plain number (or a small readonly record) out -- no classes, no
 * hidden state, nothing to configure beyond the parameters shown.
 *
 * A note on inputs: every "confidence" value accepted by these functions is
 * clamped into [0, 1] before use. Upstream data occasionally has confidences
 * a hair outside that range (floating point noise, a buggy producer, etc.),
 * and clamping means a caller gets a slightly-off-but-sane number instead of
 * a NaN or a thrown error. If you pass `NaN` itself, clamping does not fix
 * that -- `Math.max`/`Math.min` propagate `NaN` -- so upstream code should
 * not produce `NaN` confidences in the first place.
 *
 * A second note on empty/degenerate inputs: this module never throws or
 * returns `NaN` for "not enough data" situations (n = 0, one class absent,
 * etc.). Instead each function documents, in its own JSDoc, what it returns
 * in that case and why that specific value was chosen. The two exceptions
 * are `flipRate` and `meanAbsDrift`, which throw when the *shape* of the
 * input is wrong (mismatched run lengths, fewer than 2 runs) -- that is a
 * caller bug, not a data edge case, and silently returning 0 would hide it.
 */

/** One model prediction, reduced to the two things every metric here needs. */
export interface Prediction {
  /** The model's stated confidence in its answer. Expected in [0, 1]; clamped if not. */
  readonly confidence: number;
  /** Whether that answer was actually correct. */
  readonly correct: boolean;
}

/**
 * One bucket of a reliability diagram: "of the predictions we were about
 * this confident in, how often were we actually right?"
 */
export interface ReliabilityBin {
  /** Lower edge of the bin's confidence range (inclusive). */
  readonly lo: number;
  /** Upper edge of the bin's confidence range (inclusive on the last bin only). */
  readonly hi: number;
  /** How many predictions landed in this bin. */
  readonly count: number;
  /** Average stated confidence of predictions in this bin. 0 if the bin is empty. */
  readonly meanConfidence: number;
  /** Fraction of predictions in this bin that were correct. 0 if the bin is empty. */
  readonly accuracy: number;
  /**
   * `|meanConfidence - accuracy|` for this bin. A well-calibrated bin has a
   * gap near 0: a "we were 90% confident" bucket that is actually right 90%
   * of the time. A gap of 0.2 means predictions in that confidence range are
   * off by about 20 percentage points, in whichever direction (over- or
   * under-confident) `meanConfidence - accuracy`'s sign would show.
   */
  readonly gap: number;
}

/** A closed interval `[lo, hi]`, e.g. a confidence interval on a proportion. */
export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Internal invariant guard for indexing into an array we KNOW is in bounds
 * (e.g. index `i` from a `for (let i = 0; i < arr.length; i++)` over the
 * same array, or an index recovered from a `sort()` of `arr`'s own indices).
 *
 * This is not a substitute for real bounds checking on caller-supplied
 * indices -- it exists only so internal code can index arrays under
 * `noUncheckedIndexedAccess` without a non-null assertion (`!`). If it ever
 * throws, that indicates a bug in this file, not bad caller data.
 */
function at<T>(arr: readonly T[], index: number, context: string): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`internal error in ${context}: index ${index} out of bounds (length ${arr.length})`);
  }
  return value;
}

/**
 * Clamps a confidence value into [0, 1].
 *
 * Guards against upstream data that is very slightly out of range (e.g.
 * 1.0000000002 from floating point arithmetic) or outright wrong (a
 * confidence reported as a percentage like 90 instead of 0.9). Clamping
 * cannot fix `NaN` -- `Math.max`/`Math.min` return `NaN` if given one -- so
 * this is a defense against out-of-range numbers, not against non-numbers.
 */
function clampUnit(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * A Wilson score interval for a binomial proportion: given `successes` out
 * of `n` trials, how confident can you be about the TRUE underlying rate?
 *
 * Read it as: "we saw `successes/n` accuracy, but with only `n` samples the
 * true rate could plausibly be anywhere in [lo, hi]." Prefer this over the
 * naive `p ± z*sqrt(p(1-p)/n)` interval -- Wilson stays inside [0, 1] and
 * stays sane for small `n` or `p` near 0 or 1, where the naive interval can
 * go negative or above 1.
 *
 * @param successes number of successes observed (e.g. correct predictions)
 * @param n number of trials observed (e.g. total predictions)
 * @param z the z-score for the desired confidence level; default 1.96 is
 *   the ~95% level. Use 1.645 for ~90%, 2.576 for ~99%.
 * @returns `{ lo, hi }` with `0 <= lo <= hi <= 1`. When `n <= 0` there is no
 *   data to bound anything, so this returns the maximally uncertain interval
 *   `{ lo: 0, hi: 1 }` rather than dividing by zero into `NaN`.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): Interval {
  if (n <= 0) {
    return { lo: 0, hi: 1 };
  }
  // Clamp successes into a sane range in case of caller bugs (e.g. successes > n).
  const s = Math.min(Math.max(successes, 0), n);
  const phat = s / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt(phat * (1 - phat) / n + z2 / (4 * n * n));
  const lo = (center - margin) / denominator;
  const hi = (center + margin) / denominator;
  return { lo: clampUnit(lo), hi: clampUnit(hi) };
}

/**
 * Plain accuracy: the fraction of predictions that were correct.
 *
 * Read `accuracy(preds) === 0.83` as "the model got 83% of these right."
 * This says nothing about calibration -- a model can be 83% accurate while
 * being wildly over- or under-confident. See `ece` for that.
 *
 * @returns 0 for an empty input (no predictions to be accurate about).
 */
export function accuracy(preds: readonly Prediction[]): number {
  if (preds.length === 0) return 0;
  let correctCount = 0;
  for (const p of preds) {
    if (p.correct) correctCount++;
  }
  return correctCount / preds.length;
}

/**
 * Buckets predictions into `bins` EQUAL-WIDTH confidence ranges over [0, 1]
 * (e.g. with the default of 10 bins: [0, 0.1), [0.1, 0.2), ..., [0.9, 1.0])
 * and reports, per bucket, how confident the model said it was versus how
 * often it was actually right.
 *
 * This is the data behind a reliability diagram: plot `meanConfidence` on
 * the x-axis and `accuracy` on the y-axis for each bin, and a
 * well-calibrated model traces the y = x diagonal.
 *
 * Bins are defined over [0, 1] regardless of how much data falls in each
 * one, so an empty bin (no predictions with that confidence) is still
 * present in the output with `count: 0` -- this keeps the bin edges stable
 * and comparable across different evaluation runs. Compare with
 * `equalMassBins`, whose bin EDGES move to keep bin COUNTS balanced instead.
 *
 * @param bins number of equal-width buckets to split [0, 1] into. Default 10.
 * @returns exactly `bins` (or 1, whichever is larger) `ReliabilityBin`s,
 *   in increasing order of confidence. An empty bin reports
 *   `meanConfidence: 0, accuracy: 0, gap: 0` -- there's nothing to average.
 */
export function reliabilityBins(preds: readonly Prediction[], bins = 10): ReliabilityBin[] {
  const numBins = Math.max(1, Math.floor(bins));
  const width = 1 / numBins;

  const counts = new Array<number>(numBins).fill(0);
  const confSums = new Array<number>(numBins).fill(0);
  const correctSums = new Array<number>(numBins).fill(0);

  for (const p of preds) {
    const c = clampUnit(p.confidence);
    // c === 1 would floor to `numBins`, one past the last valid index, so
    // clamp it back into the final bin. This makes the last bin's range
    // effectively [1 - width, 1] inclusive on both ends.
    let idx = Math.floor(c * numBins);
    if (idx >= numBins) idx = numBins - 1;
    if (idx < 0) idx = 0;

    counts[idx] = at(counts, idx, "reliabilityBins counts") + 1;
    confSums[idx] = at(confSums, idx, "reliabilityBins confSums") + c;
    correctSums[idx] = at(correctSums, idx, "reliabilityBins correctSums") + (p.correct ? 1 : 0);
  }

  const result: ReliabilityBin[] = [];
  for (let i = 0; i < numBins; i++) {
    const count = at(counts, i, "reliabilityBins result counts");
    const confSum = at(confSums, i, "reliabilityBins result confSums");
    const correctSum = at(correctSums, i, "reliabilityBins result correctSums");
    const meanConfidence = count > 0 ? confSum / count : 0;
    const acc = count > 0 ? correctSum / count : 0;
    result.push({
      lo: i * width,
      hi: (i + 1) * width,
      count,
      meanConfidence,
      accuracy: acc,
      gap: Math.abs(meanConfidence - acc),
    });
  }
  return result;
}

/**
 * Like `reliabilityBins`, but instead of fixed-width ranges, each bin holds
 * (as close to as possible) the same NUMBER of predictions -- the bin edges
 * are quantiles of the observed confidence distribution rather than fixed
 * fractions of [0, 1].
 *
 * This matters when confidences cluster (e.g. a model that outputs 0.95 for
 * almost everything): equal-width bins would leave most bins empty and one
 * bin overloaded, making the reliability diagram noisy and hard to read.
 * Equal-mass bins keep every bin statistically meaningful at the cost of the
 * bin edges being data-dependent instead of fixed.
 *
 * @param bins requested number of bins. Default 10. If there are fewer
 *   predictions than requested bins, this is reduced to the number of
 *   predictions (one prediction per bin) -- a quantile bin with zero items
 *   in it isn't meaningful, so we don't produce one.
 * @returns bins in increasing order of confidence, sized as evenly as
 *   `n / bins` allows (counts differ by at most 1). Empty input returns `[]`
 *   -- there is no distribution to take quantiles of.
 */
export function equalMassBins(preds: readonly Prediction[], bins = 10): ReliabilityBin[] {
  const n = preds.length;
  if (n === 0) return [];

  const numBins = Math.max(1, Math.min(Math.floor(bins), n));
  const sorted = preds
    .map((p) => ({ confidence: clampUnit(p.confidence), correct: p.correct }))
    .sort((a, b) => a.confidence - b.confidence);

  const result: ReliabilityBin[] = [];
  for (let i = 0; i < numBins; i++) {
    // Standard "balanced partition" split: distributes the remainder
    // (n mod numBins) one-per-bin across the first bins, so counts never
    // differ by more than 1 across the whole set of bins.
    const start = Math.floor((i * n) / numBins);
    const end = Math.floor(((i + 1) * n) / numBins);
    if (end <= start) continue; // Cannot happen given numBins <= n, but guarded anyway.

    const firstItem = at(sorted, start, "equalMassBins firstItem");
    const lastItem = at(sorted, end - 1, "equalMassBins lastItem");

    let confSum = 0;
    let correctSum = 0;
    for (let k = start; k < end; k++) {
      const item = at(sorted, k, "equalMassBins item");
      confSum += item.confidence;
      correctSum += item.correct ? 1 : 0;
    }
    const count = end - start;
    const meanConfidence = confSum / count;
    const acc = correctSum / count;
    result.push({
      lo: firstItem.confidence,
      hi: lastItem.confidence,
      count,
      meanConfidence,
      accuracy: acc,
      gap: Math.abs(meanConfidence - acc),
    });
  }
  return result;
}

/**
 * Expected Calibration Error, computed over EQUAL-WIDTH bins.
 *
 * This is the single most common calibration summary number: the
 * count-weighted average, across confidence bins, of `|meanConfidence -
 * accuracy|`. Read `ece(preds) === 0.15` as "on average, when this model
 * states a confidence, it is off by about 15 percentage points from how
 * often it's actually right." Lower is better; 0 is perfect calibration.
 *
 * ECE says nothing about accuracy by itself -- a model can have low ECE
 * while being mostly wrong, as long as it also says it's mostly wrong.
 *
 * @param bins number of equal-width bins to use. Default 10. More bins give
 *   a finer-grained (but noisier, on small datasets) picture.
 * @returns 0 for an empty input -- there is nothing to be miscalibrated about.
 */
export function ece(preds: readonly Prediction[], bins = 10): number {
  const n = preds.length;
  if (n === 0) return 0;
  const binned = reliabilityBins(preds, bins);
  let total = 0;
  for (const bin of binned) {
    total += (bin.count / n) * bin.gap;
  }
  return total;
}

/**
 * Expected Calibration Error, computed over EQUAL-MASS (quantile) bins
 * instead of equal-width bins. See `equalMassBins` for why you might prefer
 * this over `ece`: it avoids near-empty bins when confidences cluster.
 *
 * Reads the same way as `ece`: `eceEqualMass(preds) === 0.15` means
 * predictions are off by about 15 percentage points on average, just
 * measured with data-balanced bins instead of fixed-width ones. The two
 * numbers are not directly comparable to each other unless the bins happen
 * to line up.
 *
 * @returns 0 for an empty input.
 */
export function eceEqualMass(preds: readonly Prediction[], bins = 10): number {
  const n = preds.length;
  if (n === 0) return 0;
  const binned = equalMassBins(preds, bins);
  let total = 0;
  for (const bin of binned) {
    total += (bin.count / n) * bin.gap;
  }
  return total;
}

/**
 * Brier score for binary predictions: the mean squared error between stated
 * confidence and the 0/1 outcome, i.e. `mean((confidence - (correct?1:0))^2)`.
 *
 * Unlike ECE, this is a single "how good is my probability" number that
 * blends both calibration AND sharpness (how far from 0.5 the model dares
 * to go) into one score. Lower is better: 0 is a perfect prediction every
 * time; 0.25 is what you get from confidently guessing 0.5 always; 1.0 is
 * being maximally confident and always wrong. Read `brierBinary(preds) ===
 * 0.01` as "predictions are, on average, off by 0.1 in probability terms"
 * (since 0.1^2 = 0.01) -- small Brier scores shrink fast, so compare against
 * the 0.25/1.0 landmarks above rather than treating it like a percentage.
 *
 * @returns 0 for an empty input.
 */
export function brierBinary(preds: readonly Prediction[]): number {
  if (preds.length === 0) return 0;
  let sumSquaredError = 0;
  for (const p of preds) {
    const c = clampUnit(p.confidence);
    const outcome = p.correct ? 1 : 0;
    const diff = c - outcome;
    sumSquaredError += diff * diff;
  }
  return sumSquaredError / preds.length;
}

/**
 * Brier score generalized to multiclass predictions: for each row, sum the
 * squared error between the predicted probability of each class and the
 * indicator of whether that class was the actual answer, then average that
 * per-row sum across all rows.
 *
 * Formula: `mean_over_rows( sum_over_k (p_k - 1[k == actual])^2 )`.
 *
 * Same reading as `brierBinary` -- lower is better, 0 is perfect -- but the
 * scale now also depends on how many classes there are (more classes means
 * more terms in the per-row sum), so only compare multiclass Brier scores
 * across evaluations with the same class set.
 *
 * If `actual` does not appear as a key in a row's `probabilities` (e.g. the
 * model's label set didn't include the true answer), that row is still
 * scored: the indicator is simply 0 for every listed class, so the row's
 * contribution is `sum_k p_k^2` -- this function never throws for that case,
 * since "the model didn't even offer the right answer" is itself useful
 * signal to have a real number for.
 *
 * @returns 0 for an empty input (no rows).
 */
export function brierMulticlass(
  rows: readonly { readonly probabilities: Readonly<Record<string, number>>; readonly actual: string }[],
): number {
  if (rows.length === 0) return 0;
  let sumOverRows = 0;
  for (const row of rows) {
    let rowSum = 0;
    for (const key of Object.keys(row.probabilities)) {
      const rawP = row.probabilities[key];
      const p = rawP === undefined ? 0 : clampUnit(rawP);
      const indicator = key === row.actual ? 1 : 0;
      const diff = p - indicator;
      rowSum += diff * diff;
    }
    sumOverRows += rowSum;
  }
  return sumOverRows / rows.length;
}

/**
 * Assigns "mid-ranks" to a list of numbers: 1-based ranks where tied values
 * all get the AVERAGE of the ranks they'd occupy if broken arbitrarily.
 * E.g. for `[10, 20, 20, 30]` the ranks are `[1, 2.5, 2.5, 4]` (the two 20s
 * would occupy ranks 2 and 3, so they each get 2.5).
 *
 * This is the standard tie-handling used by the Mann-Whitney U statistic,
 * which is what `auroc` is built on below.
 */
function midRanks(values: readonly number[]): number[] {
  const n = values.length;
  const order = values.map((_, i) => i).sort((a, b) => {
    const va = at(values, a, "midRanks sort a");
    const vb = at(values, b, "midRanks sort b");
    return va - vb;
  });

  const ranks = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    const startIdx = at(order, i, "midRanks start index");
    const startValue = at(values, startIdx, "midRanks start value");
    let j = i;
    while (j + 1 < n) {
      const nextIdx = at(order, j + 1, "midRanks next index");
      const nextValue = at(values, nextIdx, "midRanks next value");
      if (nextValue !== startValue) break;
      j++;
    }
    // Tie block spans 0-based positions [i, j] in sorted order, i.e.
    // 1-based ranks [i+1, j+1]. Their average is (i + j) / 2 + 1.
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      const idx = at(order, k, "midRanks assign index");
      ranks[idx] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

/**
 * Area Under the ROC Curve, using confidence as the score for predicting
 * `correct`.
 *
 * Read `auroc(preds) === 0.85` as "if you pick one correct and one
 * incorrect prediction at random, there's an 85% chance the correct one had
 * the higher stated confidence." 1.0 is perfect separation (every correct
 * prediction outranks every incorrect one), 0.5 is no better than a coin
 * flip, and 0.0 is perfectly backwards (the model is confident exactly when
 * it's wrong). Unlike accuracy or Brier score, AUROC only cares about
 * RELATIVE ordering of confidence, not the actual numeric values -- it
 * answers "does higher confidence mean more likely correct?" rather than
 * "is the confidence number itself trustworthy?" (that's what ECE is for).
 *
 * Implemented via the rank-sum (Mann-Whitney U) formula:
 * `AUC = (R1 - n1*(n1+1)/2) / (n1*n2)`, where `R1` is the sum of ranks of
 * the "positive" (correct) group among all confidences ranked together,
 * and `n1`, `n2` are the positive/negative counts. Ties in confidence are
 * handled with mid-ranks (see `midRanks`) rather than resolved by array
 * order, so the result does not depend on how equally-confident predictions
 * happen to be listed.
 *
 * @returns 0.5 when there is no data, or when every prediction is correct,
 *   or when every prediction is incorrect. In all three cases there is only
 *   one class (or none) present, so there is no "correct vs incorrect"
 *   ordering to measure discrimination against -- 0.5 ("no better than
 *   chance") is the conventional fallback most ML libraries use for this
 *   undefined case, rather than throwing or returning `NaN`.
 */
export function auroc(preds: readonly Prediction[]): number {
  const n = preds.length;
  if (n === 0) return 0.5;

  const confidences = preds.map((p) => clampUnit(p.confidence));
  let nPos = 0;
  for (const p of preds) {
    if (p.correct) nPos++;
  }
  const nNeg = n - nPos;
  if (nPos === 0 || nNeg === 0) {
    return 0.5;
  }

  const ranks = midRanks(confidences);
  let positiveRankSum = 0;
  for (let i = 0; i < n; i++) {
    const pred = at(preds, i, "auroc preds");
    const rank = at(ranks, i, "auroc ranks");
    if (pred.correct) positiveRankSum += rank;
  }

  const u1 = positiveRankSum - (nPos * (nPos + 1)) / 2;
  return u1 / (nPos * nNeg);
}

/**
 * Across several repeated runs over the SAME ordered set of items (e.g. the
 * same prompts, re-run 5 times), the fraction of items whose label came out
 * DIFFERENT in at least one run.
 *
 * Read `flipRate(runs) === 0.25` as "1 in 4 items got a different answer
 * depending on which run you happened to look at" -- a direct measure of
 * how much you can trust any single run's output at face value. 0 means
 * perfectly stable (every run agrees on every item); 1.0 means nothing was
 * ever consistent across runs (though note a flip only requires ONE
 * disagreement among possibly many runs, so this can look high even if most
 * runs agree, if a few outlier runs disagree on different items).
 *
 * @param runs `runs[i]` is the array of labels produced by run `i`, over
 *   the same items in the same order across all runs.
 * @throws Error if fewer than 2 runs are given (nothing to compare), or if
 *   the runs don't all have the same length (they don't describe the same
 *   items, which is a caller bug -- silently ignoring the extra/missing
 *   items would hide it).
 * @returns 0 if the runs are all empty (zero items, so trivially nothing flipped).
 */
export function flipRate(runs: readonly (readonly string[])[]): number {
  if (runs.length < 2) {
    throw new Error(`flipRate requires at least 2 runs to compare; got ${runs.length}`);
  }
  const firstRun = at(runs, 0, "flipRate firstRun");
  const itemCount = firstRun.length;
  for (let r = 0; r < runs.length; r++) {
    const run = at(runs, r, "flipRate length check");
    if (run.length !== itemCount) {
      throw new Error(
        `flipRate requires all runs to have the same length; run 0 has ${itemCount} items but run ${r} has ${run.length}`,
      );
    }
  }
  if (itemCount === 0) return 0;

  let flippedCount = 0;
  for (let itemIdx = 0; itemIdx < itemCount; itemIdx++) {
    const firstLabel = at(firstRun, itemIdx, "flipRate firstLabel");
    let isFlipped = false;
    for (const run of runs) {
      const label = at(run, itemIdx, "flipRate label");
      if (label !== firstLabel) {
        isFlipped = true;
        break;
      }
    }
    if (isFlipped) flippedCount++;
  }
  return flippedCount / itemCount;
}

/**
 * Across several repeated runs over the SAME ordered set of numeric items
 * (e.g. a numeric score re-computed on each run), how much does each item's
 * value swing between the most extreme runs?
 *
 * For each item, this takes `max(across runs) - min(across runs)` -- its
 * "drift" -- and then reports the mean and max of those per-item drifts
 * across all items.
 *
 * Read `meanAbsDrift(runs).mean === 0.08` as "on average, an item's value
 * swings by 0.08 between the most different runs"; `.max` tells you the
 * single worst item's swing, i.e. your worst-case instability rather than
 * the typical case.
 *
 * @param runs `runs[i]` is the array of numeric values produced by run `i`,
 *   over the same items in the same order across all runs.
 * @throws Error if fewer than 2 runs are given, or if the runs don't all
 *   have the same length -- same reasoning as `flipRate`.
 * @returns `{ mean: 0, max: 0 }` if the runs are all empty (zero items).
 */
export function meanAbsDrift(
  runs: readonly (readonly number[])[],
): { readonly mean: number; readonly max: number } {
  if (runs.length < 2) {
    throw new Error(`meanAbsDrift requires at least 2 runs to compare; got ${runs.length}`);
  }
  const firstRun = at(runs, 0, "meanAbsDrift firstRun");
  const itemCount = firstRun.length;
  for (let r = 0; r < runs.length; r++) {
    const run = at(runs, r, "meanAbsDrift length check");
    if (run.length !== itemCount) {
      throw new Error(
        `meanAbsDrift requires all runs to have the same length; run 0 has ${itemCount} items but run ${r} has ${run.length}`,
      );
    }
  }
  if (itemCount === 0) return { mean: 0, max: 0 };

  const drifts: number[] = [];
  for (let itemIdx = 0; itemIdx < itemCount; itemIdx++) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const run of runs) {
      const value = at(run, itemIdx, "meanAbsDrift value");
      if (value < min) min = value;
      if (value > max) max = value;
    }
    drifts.push(max - min);
  }

  let sum = 0;
  let worst = 0;
  for (const d of drifts) {
    sum += d;
    if (d > worst) worst = d;
  }
  return { mean: sum / drifts.length, max: worst };
}
