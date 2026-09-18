/**
 * Deterministic triage. Two jobs, and it is important they are the same code:
 *
 *   1. The fallback when Jev is unavailable, so an outage degrades the feature instead of
 *      taking it down.
 *   2. The BASELINE the eval harness compares Jev against.
 *
 * Job 2 is the uncomfortable one, and the reason it is wired in from day one: on the
 * independent phishing benchmark, a hand-written regex scored 91.8% and beat Jev's best
 * single question at 89.4%. If this function beats Jev on your labeled data, the correct
 * engineering decision is to delete the Jev call and ship this. The harness will tell you.
 */
export type Category = "billing" | "technical" | "account" | "other";

export interface Triage {
  readonly category: Category;
  readonly urgency: 0 | 1 | 2 | 3;
  readonly needsHuman: boolean;
  readonly source: "jev" | "fallback";
}

/**
 * A `type`, not an `interface`, and that is load-bearing: state is serialised into the
 * request, so it must satisfy the SDK's `EntryType`. Only type aliases get the implicit
 * index signature that makes them assignable to `{ [key: string]: JsonValue }`; an
 * interface with identical members is rejected.
 */
export type Ticket = {
  readonly subject: string;
  readonly body: string;
};

const RULES: ReadonlyArray<readonly [Category, RegExp]> = [
  ["billing", /\b(charg|invoic|refund|billing|payment|price|subscription|card declined)/i],
  ["technical", /\b(error|crash|bug|broken|not working|fail|500|timeout|latency)/i],
  ["account", /\b(login|log in|password|sign in|2fa|locked out|access|permission)/i],
];

const URGENT = /\b(urgent|asap|immediately|right now|outage|down for|all (our )?customers|production)/i;
const SOON = /\b(today|blocked|can't work|cannot work|deadline)/i;

export function triageWithRules(ticket: Ticket): Triage {
  const text = `${ticket.subject}\n${ticket.body}`;
  const category = RULES.find(([, re]) => re.test(text))?.[0] ?? "other";
  const urgency: Triage["urgency"] = URGENT.test(text) ? 3 : SOON.test(text) ? 2 : 0;
  return { category, urgency, needsHuman: true, source: "fallback" };
}
