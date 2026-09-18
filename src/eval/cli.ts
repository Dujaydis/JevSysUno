/**
 * `npm run eval -- <decision-dir> [--live] [--simulate=calibrated|overconfident] [--repeats=N]`
 *
 * Default is `--simulate`, because Jev is waitlist-gated and this must work with no key.
 * A simulated report is stamped SYNTHETIC and refuses to be mistaken for evidence.
 */
import { writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createJevClient } from "../client.js";
import type { Decision } from "../decision.js";
import { loadJsonl } from "./dataset.js";
import { evaluate, measureStability } from "./harness.js";
import { renderMarkdown, type EvalInput } from "./report.js";
import { simulatorFetch, type Regime } from "./simulator.js";
import { suggestThresholds } from "./thresholds.js";

interface Args {
  readonly dir: string;
  readonly live: boolean;
  readonly regime: Regime;
  readonly repeats: number;
}

function parseArgs(argv: readonly string[]): Args {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const dir = positional[0];
  if (dir === undefined) {
    console.error("usage: npm run eval -- <decision-dir> [--live] [--simulate=calibrated|overconfident] [--repeats=N]");
    process.exit(2);
  }
  const simulate = argv.find((a) => a.startsWith("--simulate="))?.split("=")[1];
  const repeats = Number(argv.find((a) => a.startsWith("--repeats="))?.split("=")[1] ?? "1");
  return {
    dir: resolve(dir),
    live: argv.includes("--live"),
    regime: simulate === "overconfident" ? "overconfident" : "calibrated",
    repeats: Number.isFinite(repeats) && repeats > 0 ? Math.floor(repeats) : 1,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = join(args.dir, "labeled.jsonl");
  const examples = loadJsonl<{ subject: string; body: string }>(datasetPath);

  const module = (await import(join(args.dir, "decision.js"))) as Record<string, unknown>;
  const decision = Object.values(module).find(
    (v): v is Decision<never, never, never> => typeof v === "object" && v !== null && "fingerprint" in v && "toRequest" in v,
  );
  if (decision === undefined) throw new Error(`no exported decision found in ${join(args.dir, "decision.ts")}`);

  const synthetic = !args.live;
  const client = args.live
    ? createJevClient()
    : createJevClient({
        apiKey: "simulated",
        fetch: simulatorFetch({ datasetPath, regime: args.regime, nondeterministic: args.repeats > 1 }),
        retry: { maxRetries: 0 },
      });

  if (synthetic) {
    console.warn(`[eval] SIMULATED run (regime: ${args.regime}). No real model was called. Use --live with an API key for real numbers.\n`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the CLI is deliberately untyped at this seam
  const result = await evaluate(decision as any, examples as any, client);

  // Stability is only meaningful against a live, non-deterministic backend. Replaying
  // fixtures would report a perfect 0% flip rate that says nothing about the model.
  const stability =
    args.repeats > 1
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await measureStability(decision as any, examples as any, client, args.repeats)
      : undefined;

  const input: EvalInput = {
    decision: decision.name,
    version: decision.version,
    fingerprint: decision.fingerprint,
    requestedModel: decision.model ?? "jev-latest",
    resolvedModels: result.resolvedModels,
    predictions: result.predictions,
    byTag: result.byTag,
    suggestion: suggestThresholds(result.predictions),
    ...(stability === undefined ? {} : { stability }),
    usage: { inputTokens: result.inputTokens, ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }) },
    ...(synthetic ? { synthetic: true } : {}),
  };

  const markdown = renderMarkdown(input);
  const outMd = join(args.dir, "eval-report.md");
  const outJson = join(args.dir, "eval-report.json");
  writeFileSync(outMd, `${markdown}\n`);
  writeFileSync(outJson, `${JSON.stringify(input, null, 2)}\n`);

  console.log(markdown);
  console.log(`\n[eval] wrote ${basename(outMd)} and ${basename(outJson)} to ${args.dir}`);
  if (result.failures > 0) console.warn(`[eval] ${result.failures} example(s) failed or fell back and were excluded.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
