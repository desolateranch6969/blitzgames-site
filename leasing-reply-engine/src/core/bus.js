/**
 * Async event bus.
 *
 * This is the seam other modules bolt onto. The reply engine emits facts about
 * what happened ('lead.qualified', 'tour.requested', 'human.requested'); it
 * never calls a CRM, a scheduler, or a portal directly. A module that wants to
 * act on a fact subscribes to it. Nothing in the engine breaks when nobody is
 * listening, which is the whole point of shipping this one first.
 *
 * Handlers are awaited so a subscriber can enrich a conversation before the
 * turn continues, but a throwing subscriber can never take down a reply: errors
 * are captured, reported on 'error', and the turn proceeds.
 */

/** Canonical events. Modules may emit their own namespaced events too. */
export const EVENTS = /** @type {const} */ ({
  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_CLASSIFIED: 'message.classified',
  MESSAGE_IGNORED: 'message.ignored',
  SLOTS_UPDATED: 'slots.updated',
  PLAN_READY: 'plan.ready',
  REPLY_COMPOSED: 'reply.composed',
  REPLY_SENT: 'reply.sent',
  REPLY_HELD: 'reply.held',
  LEAD_CREATED: 'lead.created',
  LEAD_QUALIFIED: 'lead.qualified',
  TOUR_REQUESTED: 'tour.requested',
  LISTINGS_REQUESTED: 'listings.requested',
  HUMAN_REQUESTED: 'human.requested',
  COMPLIANCE_FLAGGED: 'compliance.flagged',
  OPTED_OUT: 'lead.opted_out',
  ERROR: 'error',
});

export function createBus({ logger } = {}) {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  /** @type {Set<Function>} */
  const wildcard = new Set();

  /**
   * @param {string} event Event name, or '*' for every event.
   * @param {(payload: any, meta: {event: string}) => any} handler
   * @returns {() => void} unsubscribe
   */
  function on(event, handler) {
    if (event === '*') {
      wildcard.add(handler);
      return () => wildcard.delete(handler);
    }
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => handlers.get(event)?.delete(handler);
  }

  /** Subscribe for exactly one delivery. */
  function once(event, handler) {
    const off = on(event, async (payload, meta) => {
      off();
      return handler(payload, meta);
    });
    return off;
  }

  /**
   * Deliver an event. Always resolves; subscriber failures are isolated.
   * @param {string} event
   * @param {any} payload
   */
  async function emit(event, payload) {
    const meta = { event };
    const targets = [...(handlers.get(event) ?? []), ...wildcard];
    for (const handler of targets) {
      try {
        await handler(payload, meta);
      } catch (err) {
        logger?.error('bus handler failed', { event, error: String(err?.stack ?? err) });
        if (event !== EVENTS.ERROR) {
          await emit(EVENTS.ERROR, { source: 'bus', event, error: err });
        }
      }
    }
  }

  return { on, once, emit, EVENTS, listenerCount: (e) => (handlers.get(e)?.size ?? 0) + wildcard.size };
}
