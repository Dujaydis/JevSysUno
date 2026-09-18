/**
 * Escalation hooks.
 *
 * Core ships only escalators that need no external service. An LLM-backed escalator is a
 * perfectly good idea -- and it lives in `examples/`, not here, because the moment this
 * library takes a dependency on a text model it stops being a Jev integration and starts
 * being a framework with opinions about your model vendor too.
 */
import type { EntryType, Questions } from "@typesafe-ai/sdk";
import type { Answers, Escalator, Meta } from "./types.js";

/** Accept the provisional outcome unchanged. Honest default: it does nothing and says so. */
export function noopEscalator<Q extends Questions, S extends EntryType, O>(): Escalator<Q, S, O> {
  return {
    name: "noop",
    escalate: ({ provisional }) => Promise.resolve(provisional),
  };
}

export interface QueuedItem<Q extends Questions, S extends EntryType, O> {
  readonly state: S;
  readonly answers: Answers<Q>;
  readonly provisional: O;
  readonly meta: Meta;
}

/**
 * Push to a human review queue and return the provisional outcome meanwhile.
 *
 * The caller still gets `kind: "escalated"`, so the type system stops them treating the
 * provisional value as decided.
 */
export function queueEscalator<Q extends Questions, S extends EntryType, O>(
  enqueue: (item: QueuedItem<Q, S, O>) => void | Promise<void>,
): Escalator<Q, S, O> {
  return {
    name: "queue",
    escalate: async (item) => {
      await enqueue(item);
      return item.provisional;
    },
  };
}
