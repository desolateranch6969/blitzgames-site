/**
 * Rate limiting and send pacing.
 *
 * Two separate concerns, both of which get an account banned if ignored:
 * per-thread flooding (one lead being buried in replies) and per-account burst
 * (the platform seeing automation). Counters are in-memory by default; a future
 * module can provide a shared implementation for multi-process deployments by
 * registering the `ratelimit` capability.
 */

/**
 * @param {{perThreadPerHour?: number, perAccountPerMinute?: number, now?: () => number}} [opts]
 */
export function createRateLimiter(opts = {}) {
  const perThreadPerHour = opts.perThreadPerHour ?? 12;
  const perAccountPerMinute = opts.perAccountPerMinute ?? 20;
  const now = opts.now ?? (() => Date.now());

  /** @type {Map<string, number[]>} */
  const threadHits = new Map();
  /** @type {number[]} */
  let accountHits = [];

  function prune(list, windowMs, t) {
    const cutoff = t - windowMs;
    let i = 0;
    while (i < list.length && list[i] < cutoff) i++;
    return i ? list.slice(i) : list;
  }

  /**
   * @param {string} threadId
   * @returns {{allowed: boolean, reason?: string, retryAfterMs?: number}}
   */
  function check(threadId) {
    const t = now();
    const thread = prune(threadHits.get(threadId) ?? [], 3600_000, t);
    threadHits.set(threadId, thread);
    accountHits = prune(accountHits, 60_000, t);

    if (thread.length >= perThreadPerHour) {
      return {
        allowed: false,
        reason: `thread limit reached (${perThreadPerHour}/hour)`,
        retryAfterMs: thread[0] + 3600_000 - t,
      };
    }
    if (accountHits.length >= perAccountPerMinute) {
      return {
        allowed: false,
        reason: `account limit reached (${perAccountPerMinute}/minute)`,
        retryAfterMs: accountHits[0] + 60_000 - t,
      };
    }
    return { allowed: true };
  }

  /** @param {string} threadId */
  function record(threadId) {
    const t = now();
    threadHits.set(threadId, [...(threadHits.get(threadId) ?? []), t]);
    accountHits.push(t);
  }

  return { check, record, reset: () => { threadHits.clear(); accountHits = []; } };
}

/**
 * Message-window policy.
 *
 * Meta's messaging platform only permits a business to reply inside a limited
 * window after the user's last message (24 hours for the standard window, with
 * a single further-reply allowance under the human-agent tag). Sending outside
 * it fails at the API and counts against the account, so the engine checks
 * before it composes rather than after it is rejected.
 *
 * @param {import('../core/types.js').Conversation} convo
 * @param {{windowMs?: number, now?: number}} [opts]
 */
export function withinReplyWindow(convo, opts = {}) {
  const windowMs = opts.windowMs ?? 24 * 3600_000;
  const now = opts.now ?? Date.now();
  const lastInbound = convo.lastInboundAt ?? [...convo.turns].reverse().find((t) => t.role === 'lead')?.at;
  if (!lastInbound) return { ok: false, reason: 'no inbound message on this thread yet' };
  const age = now - lastInbound;
  if (age > windowMs) {
    return {
      ok: false,
      reason: `last inbound was ${Math.round(age / 3600_000)}h ago, outside the ${Math.round(windowMs / 3600_000)}h reply window`,
      ageMs: age,
    };
  }
  return { ok: true, ageMs: age };
}
