/**
 * Labeled datasets.
 *
 * The `tag` field is the most important part of this file. On the independent tool-call
 * benchmark Jev scored 100% on clear cases and 71.4% on ambiguous ones -- an aggregate of
 * 91.7% that conceals a 29-point collapse exactly where production traffic lives. As that
 * benchmark's authors put it: "a benchmark of only obvious cases returns 100% and tells
 * you nothing." So the report always breaks metrics out by tag, and refuses to be read as
 * a single number.
 */
import { readFileSync } from "node:fs";

/** `clear` = unambiguous. `ambiguous` = a careful human might hesitate. `adversarial` = designed to mislead. */
export type Tag = "clear" | "ambiguous" | "adversarial";

export interface LabeledExample<S> {
  readonly id: string;
  readonly state: S;
  /** Ground truth for the PRIMARY question, as the label/level it should produce. */
  readonly expected: string;
  readonly tag: Tag;
  readonly note?: string;
}

/**
 * Read a JSONL file of labeled examples.
 *
 * JSONL rather than JSON so a dataset can be appended to from a review queue without
 * rewriting the file, and so a bad line names its own line number.
 */
export function loadJsonl<S>(path: string): LabeledExample<S>[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const out: LabeledExample<S>[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (cause) {
      throw new Error(`${path}:${i + 1} is not valid JSON`, { cause });
    }
    const row = parsed as Partial<LabeledExample<S>>;
    if (typeof row.id !== "string" || typeof row.expected !== "string" || row.state === undefined) {
      throw new Error(`${path}:${i + 1} needs at least "id", "state" and "expected"`);
    }
    out.push({ ...row, tag: row.tag ?? "clear" } as LabeledExample<S>);
  });
  return out;
}

export function byTag<S>(examples: readonly LabeledExample<S>[]): Record<Tag, LabeledExample<S>[]> {
  const groups: Record<Tag, LabeledExample<S>[]> = { clear: [], ambiguous: [], adversarial: [] };
  for (const example of examples) groups[example.tag].push(example);
  return groups;
}
