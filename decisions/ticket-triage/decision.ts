/**
 * Reference decision: support-ticket triage.
 *
 * Three questions asked in ONE request. They evaluate in parallel against the same state
 * and cannot see each other's answers, so adding the second and third costs almost nothing
 * in latency -- but they must be genuinely independent. "Is this billing?" and "what
 * category is this?" would be a mistake: the second subsumes the first.
 */
import { choice, noul, score } from "@typesafe-ai/sdk";
import { defineDecision } from "../../src/index.js";
import { mostLikelyLevel } from "../../src/index.js";
import type { Category, Ticket, Triage } from "./fallback.js";
import { triageWithRules } from "./fallback.js";

export const ticketTriage = defineDecision<Ticket>()({
  name: "ticket-triage",
  version: 1,

  // Left on the alias deliberately so the dev-mode warning fires and you read it.
  // For production: pin a concrete name from GET /v1/models here.
  // model: "jev-1.x",

  questions: {
    category: choice(
      "Which part of the product is this support ticket about? Judge by what the customer needs help with, " +
        "not by which words appear. Read `subject` and `body` together.",
      {
        billing: "Charges, invoices, refunds, payment methods, pricing or subscription changes.",
        technical: "The product is malfunctioning: errors, crashes, incorrect behaviour or performance problems.",
        account: "Access to the account itself: sign-in, passwords, two-factor, permissions or seats.",
        other: "Anything else, including feature requests, general questions and messages that fit none of the above.",
      },
    ),
    urgency: score(
      "How soon does this ticket need a human response, judged by the customer's stated situation and the " +
        "business impact described in `body`? Ignore politeness and tone; judge consequence.",
      [
        "No time pressure. A reply within the week is fine.",
        "Should be answered in the next day or two. The customer is inconvenienced but working.",
        "Needs an answer today. The customer is blocked from doing something important.",
        "Needs an answer now. Something is actively broken for paying users or money is at stake.",
      ],
    ),
    refundRisk: noul(
      "Is this customer likely to request a refund or cancel their subscription if this is not resolved well?",
      {
        true: "The message expresses enough frustration, financial harm or stated intent to leave that churn is a real risk.",
        false: "The customer is simply reporting a problem or asking a question, with no sign of churn risk.",
      },
    ),
  },

  // The category drives the band: a misrouted ticket is the failure that costs most here.
  primary: "category",

  // PROVENANCE: placeholder values. These have NOT been derived from an eval report,
  // because no live API access was available. Run `npm run eval -- ticket-triage` against
  // your own labeled data and replace these with the report's suggestion before you let
  // anything auto-act. Shipping these as-is is the mistake this comment exists to prevent.
  thresholds: { act: 0.9, review: 0.6 },

  decide: (answers, ticket): Triage => ({
    category: answers.category.choice as Category,

    // NOTE: mostLikelyLevel, not Math.round(answers.urgency.score).
    // `score` is a probability-weighted average, so a distribution split between levels 0
    // and 3 returns 1.5 -- rounding that to 2 reports a level the model never predicted.
    urgency: mostLikelyLevel(answers.urgency) as Triage["urgency"],

    // Policy, expressed in code where it can be read and tested. Two independent reasons
    // to involve a person; an "any serious condition" rule needs separate conditions
    // rather than a weighted score that lets one signal compensate for the other.
    needsHuman: answers.refundRisk.noul > 0.6 || mostLikelyLevel(answers.urgency) >= 3,

    source: "jev",
  }),

  fallback: (ticket) => triageWithRules(ticket),
});
