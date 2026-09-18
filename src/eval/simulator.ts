/**
 * A deterministic fake Jev, for demonstrating the harness without API access.
 *
 * This exists because Jev is in waitlisted early access and CI cannot reach it. It is a
 * TEACHING TOOL, not a model: it produces plausibly-shaped distributions with a
 * configurable calibration regime so you can watch the report change. Every report
 * generated through it is stamped `synthetic: true`.
 *
 * The two regimes are drawn from the two independent benchmarks, which disagreed:
 *   - `calibrated`   ~ the tool-call-risk result (0.9-1.0 bin was 98% accurate)
 *   - `overconfident`~ the phishing result (ECE 0.154, worse than Haiku's 0.097)
 *
 * The point of being able to flip between them is that the SAME thresholds produce a safe
 * system under one and a quietly broken one under the other.
 */
import type { Fetch } from "@typesafe-ai/sdk";
import { loadJsonl, type LabeledExample } from "./dataset.js";

export type Regime = "calibrated" | "overconfident";

/** Mulberry32: small, fast, deterministic. Seeded per example so replays are stable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface SimulatorOptions {
  readonly datasetPath: string;
  readonly regime?: Regime;
  /** Adds jitter per call so repeated identical requests differ, as the real model does. */
  readonly nondeterministic?: boolean;
}

/**
 * A `Fetch` that answers `/v1/systemone` from the labeled set.
 *
 * It gets the answer right with a probability that depends on the example's difficulty
 * tag -- mirroring the measured 100% / 71.4% clear-vs-ambiguous split -- and reports a
 * confidence that is either honest or inflated depending on the regime.
 */
export function simulatorFetch(options: SimulatorOptions): Fetch {
  const examples = loadJsonl<{ subject: string; body: string }>(options.datasetPath);
  const byState = new Map<string, LabeledExample<{ subject: string; body: string }>>();
  for (const example of examples) byState.set(JSON.stringify(example.state), example);
  const regime = options.regime ?? "calibrated";
  let nonce = 0;

  return (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, "https://api.typesafe.ai");
    if (url.pathname === "/v1/models") {
      return Promise.resolve(
        json({ models: [{ name: "jev-sim-1.0", description: "Simulated. Not a real model.", release_date: "2026-09-15" }] }),
      );
    }

    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      state: unknown;
      questions: Record<string, { type: string; criteria?: unknown }>;
    };
    const example = byState.get(JSON.stringify(body.state));
    const seed = hash(JSON.stringify(body.state)) + (options.nondeterministic ? (nonce += 1) * 7919 : 0);
    const rand = rng(seed);

    // Accuracy by difficulty, echoing the independent tool-call benchmark's shape.
    const pCorrect = example === undefined ? 0.5 : { clear: 0.97, ambiguous: 0.71, adversarial: 0.55 }[example.tag];
    const correct = rand() < pCorrect;

    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(body.questions)) {
      answers[name] = answerFor(question, example?.expected, correct, rand, regime);
    }

    return Promise.resolve(
      json({ model: "jev-sim-1.0", answers, usage: { input_tokens: 90 + Math.floor(rand() * 60), output_tokens: 4 } }),
    );
  };
}

function answerFor(
  question: { type: string; criteria?: unknown },
  expected: string | undefined,
  correct: boolean,
  rand: () => number,
  regime: Regime,
): unknown {
  // Honest confidence under "calibrated"; inflated under "overconfident" so that stated
  // certainty outruns actual accuracy -- which is exactly what a high ECE means.
  const base = 0.55 + rand() * 0.44;
  const confidence = regime === "overconfident" ? Math.min(0.995, base + 0.22) : base;

  if (question.type === "noul") {
    const yes = correct ? confidence : 1 - confidence;
    return { type: "noul", noul: round(yes) };
  }

  if (question.type === "choice") {
    const labels = Object.keys(question.criteria as Record<string, unknown>);
    const target = expected !== undefined && labels.includes(expected) ? expected : labels[0] ?? "other";
    const wrong = labels.filter((l) => l !== target);
    const picked = correct ? target : wrong[Math.floor(rand() * wrong.length)] ?? target;
    return { type: "choice", choice: picked, confidence: round(confidence), probabilities: spread(labels, picked, confidence) };
  }

  const levels = (question.criteria as unknown[]).map((_, i) => String(i));
  const picked = levels[Math.floor(rand() * levels.length)] ?? "0";
  const probabilities = spread(levels, picked, confidence);
  const score = levels.reduce((sum, key) => sum + Number(key) * (probabilities[key] ?? 0), 0);
  return { type: "score", score: round(score), confidence: round(confidence), legend: legendFor(levels), probabilities };
}

/** A distribution peaking on `winner` at `peak`, remainder split evenly, renormalised to 1. */
function spread(keys: readonly string[], winner: string, peak: number): Record<string, number> {
  const others = keys.length - 1;
  const rest = others > 0 ? (1 - peak) / others : 0;
  const out: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const value = key === winner ? peak : rest;
    out[key] = value;
    sum += value;
  }
  for (const key of keys) out[key] = round((out[key] ?? 0) / sum);
  return out;
}

function legendFor(levels: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const level of levels) out[level] = `level ${level}`;
  return out;
}

const round = (n: number): number => Math.round(n * 10000) / 10000;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-typesafe-request-id": "simulated" },
  });
