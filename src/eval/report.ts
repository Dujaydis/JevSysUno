/**
 * Rendering an eval report.
 *
 * The report is opinionated about what it refuses to say. It never prints a single
 * headline accuracy without the per-tag breakdown beside it, it never suggests a threshold
 * from thin data, and it always compares against the deterministic baseline -- because on
 * the one independent benchmark where someone bothered to check, a regex beat Jev.
 */
import type { Prediction } from "./metrics.js";
import { accuracy, auroc, brierBinary, ece, eceEqualMass, reliabilityBins, wilsonInterval } from "./metrics.js";
import type { Tag } from "./dataset.js";
import type { ThresholdSuggestion } from "./thresholds.js";

export interface EvalInput {
  readonly decision: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly requestedModel: string;
  readonly resolvedModels: readonly string[];
  readonly predictions: readonly Prediction[];
  readonly byTag: Readonly<Record<Tag, readonly Prediction[]>>;
  /** Same examples scored by the deterministic fallback. The question is whether Jev beats it. */
  readonly baseline?: readonly Prediction[];
  readonly suggestion: ThresholdSuggestion;
  readonly stability?: { readonly flipRate: number; readonly drift: { mean: number; max: number }; readonly repeats: number };
  readonly usage?: { readonly inputTokens: number; readonly costUsd?: number };
  readonly synthetic?: boolean;
}

export function renderMarkdown(input: EvalInput): string {
  const n = input.predictions.length;
  const acc = accuracy(input.predictions);
  const ci = wilsonInterval(Math.round(acc * n), n);
  const lines: string[] = [];

  lines.push(`# Eval report: ${input.decision} v${input.version}`, "");
  if (input.synthetic) {
    lines.push(
      "> **This report was produced from SYNTHETIC data.** No live Jev API access was available.",
      "> The numbers below demonstrate the harness, not the model. Do not set thresholds from them.",
      "",
    );
  }
  lines.push(
    `- fingerprint: \`${input.fingerprint}\``,
    `- requested model: \`${input.requestedModel}\``,
    `- resolved model(s): ${input.resolvedModels.map((m) => `\`${m}\``).join(", ") || "_none recorded_"}`,
    `- examples: ${n}`,
    "",
  );

  if (input.resolvedModels.length > 1) {
    lines.push(
      "> **The alias moved during this run.** More than one model answered, so these metrics mix two models.",
      "> Pin a concrete version and re-run before trusting anything below.",
      "",
    );
  }

  lines.push("## Headline", "");
  lines.push(`Accuracy **${pct(acc)}** (95% CI ${pct(ci.lo)}–${pct(ci.hi)})`, "");
  lines.push(
    "A single accuracy number is the least useful line in this report. Read the breakdown below before quoting it.",
    "",
  );

  lines.push("## By difficulty", "");
  lines.push("| tag | n | accuracy | 95% CI |", "|---|---|---|---|");
  for (const tag of ["clear", "ambiguous", "adversarial"] as const) {
    const preds = input.byTag[tag];
    if (preds.length === 0) {
      lines.push(`| ${tag} | 0 | — | _no examples_ |`);
      continue;
    }
    const a = accuracy(preds);
    const c = wilsonInterval(Math.round(a * preds.length), preds.length);
    lines.push(`| ${tag} | ${preds.length} | ${pct(a)} | ${pct(c.lo)}–${pct(c.hi)} |`);
  }
  lines.push("");
  if (input.byTag.ambiguous.length === 0 && input.byTag.adversarial.length === 0) {
    lines.push(
      "> **Every example here is tagged `clear`.** This report cannot tell you whether the decision works.",
      "> Add ambiguous and adversarial cases — a benchmark of only obvious cases returns a high number and",
      "> tells you nothing.",
      "",
    );
  }

  lines.push("## Calibration", "");
  lines.push(
    `- ECE (equal-width bins): **${input.predictions.length ? ece(input.predictions).toFixed(3) : "—"}**`,
    `- ECE (equal-mass bins): **${input.predictions.length ? eceEqualMass(input.predictions).toFixed(3) : "—"}**`,
    `- Brier score: **${input.predictions.length ? brierBinary(input.predictions).toFixed(3) : "—"}**`,
    `- AUROC (confidence → correctness): **${input.predictions.length ? auroc(input.predictions).toFixed(3) : "—"}**`,
    "",
    "ECE is the average gap between stated confidence and observed accuracy: 0.15 means predictions are off by",
    "roughly 15 percentage points. For scale, the independent phishing benchmark measured Jev at **0.154** and",
    "Haiku 4.5 at **0.097** on the same data. AUROC near 0.5 means confidence carries no information about",
    "correctness — in which case a confidence-banded escalation path is decoration.",
    "",
  );

  lines.push("### Reliability", "");
  lines.push("| confidence | n | mean conf | accuracy | gap | reads as |", "|---|---|---|---|---|---|");
  for (const bin of reliabilityBins(input.predictions)) {
    if (bin.count === 0) continue;
    // `ReliabilityBin.gap` is |confidence - accuracy|, because ECE needs the absolute
    // deviation. For a human reading the table the DIRECTION is the useful part, so
    // recover the sign here rather than weakening the metric.
    const signed = bin.meanConfidence - bin.accuracy;
    const reads = Math.abs(signed) < 0.05 ? "well calibrated" : signed > 0 ? "**overconfident**" : "underconfident";
    lines.push(
      `| ${bin.lo.toFixed(1)}\u2013${bin.hi.toFixed(1)} | ${bin.count} | ${bin.meanConfidence.toFixed(3)} | ${bin.accuracy.toFixed(3)} | ${signed >= 0 ? "+" : "-"}${Math.abs(signed).toFixed(3)} | ${reads} |`,
    );
  }
  lines.push(
    "",
    "`gap` is mean confidence minus observed accuracy. **Positive means overconfident** - it claimed more",
    "certainty than it earned. That is the dangerous direction, because the auto-act band is drawn from the",
    "high-confidence end. Underconfidence only costs you unnecessary human review.",
    "",
  );

  if (input.baseline && input.baseline.length > 0) {
    const b = accuracy(input.baseline);
    lines.push("## Versus the deterministic baseline", "");
    lines.push(`- baseline (rules/regex): **${pct(b)}**`, `- Jev: **${pct(acc)}**`, "");
    lines.push(
      acc > b
        ? `Jev beats the rules by ${pct(acc - b)}. That margin is what you are buying — weigh it against the vendor dependency.`
        : "**The deterministic baseline matches or beats Jev on this data.** The correct engineering decision is to " +
          "ship the rules and delete the API call. This is not a hypothetical: on the independent phishing " +
          "benchmark a regex scored 91.8% against Jev's best single question at 89.4%.",
      "",
    );
  }

  if (input.stability) {
    lines.push("## Stability", "");
    lines.push(
      `Across ${input.stability.repeats} runs of identical inputs:`,
      "",
      `- label flip rate: **${pct(input.stability.flipRate)}**`,
      `- mean probability drift: **${input.stability.drift.mean.toFixed(4)}** (max ${input.stability.drift.max.toFixed(4)})`,
      "",
      "Jev is not deterministic. The independent phishing benchmark measured 2.2% label flips on identical",
      "inputs (Haiku 4.5: 0.7%). A confidence that moves between calls cannot carry an escalation path built to",
      "three decimal places.",
      "",
    );
  }

  lines.push("## Suggested thresholds", "");
  lines.push("```", input.suggestion.rationale, "```", "");
  if (input.suggestion.act !== undefined) {
    lines.push(
      "```ts",
      `thresholds: { act: ${input.suggestion.act.toFixed(2)}, review: ${(input.suggestion.review ?? 0.5).toFixed(2)} },`,
      `// derived from eval-report ${new Date().toISOString().slice(0, 10)}, model ${input.resolvedModels[0] ?? input.requestedModel}, n=${n}`,
      "```",
      "",
    );
  }

  if (input.usage) {
    lines.push("## Cost", "");
    lines.push(
      `- input tokens: ${input.usage.inputTokens.toLocaleString("en-US")}`,
      input.usage.costUsd === undefined
        ? "- estimated cost: **unknown** — set `JEV_PRICE_PER_M_INPUT_USD` once you have read the real figure off TypeSafe's pricing page. The widely-quoted $0.042/M is unverified."
        : `- estimated cost: $${input.usage.costUsd.toFixed(6)}`,
      "",
    );
  }

  return lines.join("\n");
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
