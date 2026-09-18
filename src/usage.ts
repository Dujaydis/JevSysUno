/**
 * Cost and usage accounting.
 *
 * Cost estimation is opt-in and returns `undefined` by default, on purpose. The
 * widely-quoted $0.042 per million input tokens could not be confirmed from any
 * first-party TypeSafe source -- it appears only in secondary blogs. A confident wrong
 * number in a budget spreadsheet is worse than no number, so you must supply the price
 * yourself via JEV_PRICE_PER_M_INPUT_USD once you have read it off the real pricing page.
 */
import type { Meta } from "./types.js";

export interface UsageRecord extends Meta {
  readonly at: string;
  readonly band?: string;
  readonly kind: string;
}

/**
 * Cost in USD, or `undefined` when the price is unknown.
 *
 * Output tokens are excluded: the OpenAPI field description for `usage.output_tokens`
 * states they are "currently free of charge" -- the one pricing fact that IS first-party.
 * "Currently" is doing load-bearing work in that sentence; re-check it.
 */
export function estimateCostUsd(inputTokens: number, pricePerMillionUsd?: number): number | undefined {
  const price = pricePerMillionUsd ?? readEnvPrice();
  if (price === undefined) return undefined;
  return (inputTokens / 1_000_000) * price;
}

function readEnvPrice(): number | undefined {
  const raw = process.env["JEV_PRICE_PER_M_INPUT_USD"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * An in-memory ledger of every call. Swap `sink` for a JSONL writer or your metrics
 * pipeline in production; the point is that model drift and cost creep are questions you
 * can only answer if you recorded the resolved model and the token counts at the time.
 */
export class Ledger {
  readonly #records: UsageRecord[] = [];
  constructor(private readonly sink?: (record: UsageRecord) => void) {}

  record(meta: Meta, kind: string, band?: string): void {
    const record: UsageRecord = { ...meta, at: new Date().toISOString(), kind, ...(band === undefined ? {} : { band }) };
    this.#records.push(record);
    this.sink?.(record);
  }

  get records(): readonly UsageRecord[] {
    return this.#records;
  }

  /** Totals, plus the set of resolved models seen -- more than one means an alias moved under you. */
  summary(): { calls: number; inputTokens: number; costUsd?: number; resolvedModels: string[] } {
    let inputTokens = 0;
    let costUsd = 0;
    let anyCost = false;
    const models = new Set<string>();
    for (const r of this.#records) {
      inputTokens += r.usage?.input_tokens ?? 0;
      if (r.estimatedCostUsd !== undefined) {
        costUsd += r.estimatedCostUsd;
        anyCost = true;
      }
      if (r.resolvedModel !== undefined) models.add(r.resolvedModel);
    }
    return {
      calls: this.#records.length,
      inputTokens,
      ...(anyCost ? { costUsd } : {}),
      resolvedModels: [...models],
    };
  }
}
