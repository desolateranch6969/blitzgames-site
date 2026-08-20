/**
 * The source contract.
 *
 * Every way a lead can arrive implements the same four methods, so the pipeline
 * behind them never learns where anything came from. That matters here more than
 * usual, because the collection methods have wildly different reliability:
 * the official API can lose access on a policy change, a logged-in session can be
 * invalidated at any time, and a physical phone can simply be unplugged. When one
 * degrades, the others keep filling the same funnel.
 *
 *   name          identifies the source in provenance
 *   start(ctx)    optional setup
 *   poll()        returns RawEvent[] since the last cursor — pull sources
 *   push(payload) hands the pipeline events — push sources (webhooks)
 *   health()      is this source actually working right now
 *
 * A source's ONLY job is to produce faithful RawEvents. No triage, no identity
 * resolution, no enrichment. If a source starts interpreting, the pipeline
 * becomes untestable and the raw record stops being raw.
 */

/**
 * @typedef {Object} SourceHealth
 * @property {'ok'|'degraded'|'down'|'unconfigured'} status
 * @property {string} [detail]
 * @property {string} [lastEventAt]
 * @property {string} [lastPolledAt]
 *
 * @typedef {Object} Source
 * @property {string} name
 * @property {'pull'|'push'} mode
 * @property {(ctx: any) => any} [start]
 * @property {() => Promise<import('../core/types.js').RawEvent[]>} [poll]
 * @property {(payload: any) => Promise<import('../core/types.js').RawEvent[]>} [push]
 * @property {() => Promise<SourceHealth>} health
 * @property {() => any} [stop]
 */

/**
 * Build a RawEvent with the fields the pipeline requires, so no source has to
 * remember the shape.
 *
 * @param {{
 *   source: string, kind?: import('../core/types.js').RawEvent['kind'],
 *   platform?: string, platformId: string, handle?: string, displayName?: string,
 *   id?: string, threadId?: string, text?: string, occurredAt?: string|number,
 *   payload?: Record<string, unknown>,
 * }} input
 * @returns {import('../core/types.js').RawEvent}
 */
export function makeRawEvent(input) {
  const occurredAt = normalizeTime(input.occurredAt);
  return {
    id: input.id ?? `${input.source}:${input.platformId}:${occurredAt ?? Date.now()}`,
    source: input.source,
    kind: input.kind ?? 'message',
    observedAt: new Date().toISOString(),
    occurredAt,
    actor: {
      platform: input.platform ?? 'instagram',
      platformId: String(input.platformId),
      handle: input.handle,
      displayName: input.displayName,
    },
    threadId: input.threadId,
    text: input.text ?? '',
    payload: input.payload ?? {},
  };
}

function normalizeTime(value) {
  if (value == null) return undefined;
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/**
 * A cursor store so pull sources resume where they stopped instead of
 * re-ingesting everything after a restart.
 * @param {{get: Function, set: Function}} [backing]
 */
export function createCursorStore(backing) {
  const memory = new Map();
  return {
    async get(name) {
      return backing ? backing.get(name) : memory.get(name) ?? null;
    },
    async set(name, cursor) {
      if (backing) return backing.set(name, cursor);
      memory.set(name, cursor);
    },
  };
}

/**
 * Wrap a source so a failing poll degrades instead of throwing into the
 * scheduler. A source that is down must never stop the sources that are up.
 * @param {Source} source
 * @param {{logger?: any}} [opts]
 * @returns {Source}
 */
export function resilient(source, opts = {}) {
  let consecutiveFailures = 0;
  let lastError = null;

  return {
    ...source,
    async poll() {
      if (!source.poll) return [];
      try {
        const events = await source.poll();
        consecutiveFailures = 0;
        lastError = null;
        return events;
      } catch (err) {
        consecutiveFailures++;
        lastError = err;
        opts.logger?.error?.('source poll failed', {
          source: source.name,
          consecutiveFailures,
          error: String(err?.message ?? err),
        });
        return [];
      }
    },
    async health() {
      const base = await source.health().catch(() => ({ status: 'down', detail: 'health check threw' }));
      if (consecutiveFailures === 0) return base;
      return {
        ...base,
        status: consecutiveFailures > 3 ? 'down' : 'degraded',
        detail: `${consecutiveFailures} consecutive failures: ${String(lastError?.message ?? lastError)}`,
      };
    },
  };
}
