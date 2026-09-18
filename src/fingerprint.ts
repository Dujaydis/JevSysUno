/**
 * Stable identity for a decision's semantic content.
 *
 * `version` is the human-facing number a developer bumps. `fingerprint` is the number
 * that catches the developer who forgot. Recorded fixtures and eval reports are keyed by
 * fingerprint, so changing a question's wording invalidates them loudly instead of
 * silently comparing against results from a different question.
 */
import { createHash } from "node:crypto";

/**
 * JSON with deterministically ordered object keys.
 *
 * `JSON.stringify` preserves insertion order, so two semantically identical question
 * objects written in a different order would otherwise hash differently. Arrays keep
 * their order -- for `score` criteria the order IS the meaning (index = level).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    out[key] = sortKeys(source[key]);
  }
  return out;
}

/** sha256 of the canonical JSON, hex, truncated to 16 chars -- enough to disambiguate, short enough to read in a log. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}
