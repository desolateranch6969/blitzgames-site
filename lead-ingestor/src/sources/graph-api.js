/**
 * Official Meta Graph API source.
 *
 * The sanctioned path, and the one to lean on wherever it reaches. It runs
 * against a professional Instagram account linked to a Facebook Page, using the
 * same app registration the reply engine uses for sending.
 *
 * Two modes:
 *   push  - webhook events forwarded in from the reply engine's HTTP server, so
 *           one webhook subscription feeds both modules.
 *   poll  - a conversations sweep, which catches anything a webhook dropped
 *           (delivery is best-effort and a restart loses whatever was in flight).
 *
 * What this source can and cannot see is the reason the other sources exist:
 *
 *   Covered      DMs to a professional account, message attachments, story
 *                replies that arrive as messages.
 *   Not covered  DMs to a personal account (no API at all), comment threads
 *                unless separately subscribed, follow requests, message requests
 *                sitting in the "hidden requests" folder, and anything older than
 *                the API's retention window.
 */
import { makeRawEvent } from './source.js';

const DEFAULT_VERSION = 'v21.0';

/**
 * @param {{
 *   accountId?: string, pageAccessToken?: string, graphVersion?: string,
 *   fetchImpl?: typeof fetch, logger?: any, pageSize?: number,
 * }} config
 * @returns {import('./source.js').Source & {handleWebhookPayload: Function}}
 */
export function createGraphApiSource(config = {}) {
  const {
    accountId = process.env.IG_ACCOUNT_ID,
    pageAccessToken = process.env.IG_PAGE_ACCESS_TOKEN,
    graphVersion = process.env.IG_GRAPH_VERSION || DEFAULT_VERSION,
    fetchImpl = globalThis.fetch,
    logger,
    pageSize = 25,
  } = config;

  let lastPolledAt = null;
  let lastEventAt = null;
  /** @type {string|null} */
  let sinceCursor = null;

  async function graph(path, params = {}) {
    const url = new URL(`https://graph.facebook.com/${graphVersion}/${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${pageAccessToken}` } });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`graph api ${response.status} on ${path}: ${detail.slice(0, 300)}`);
    }
    return response.json();
  }

  /**
   * Translate a webhook payload into RawEvents. Same shape the reply engine's
   * Instagram adapter parses, kept separate so the two modules stay independent.
   * @param {any} payload
   */
  function handleWebhookPayload(payload) {
    /** @type {import('../core/types.js').RawEvent[]} */
    const events = [];
    if (payload?.object !== 'instagram' && payload?.object !== 'page') return events;

    for (const entry of payload.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        const message = event.message;
        if (!message || message.is_echo || message.is_deleted) continue;
        const senderId = event.sender?.id;
        if (!senderId || senderId === accountId) continue;

        events.push(
          makeRawEvent({
            source: 'graph-api',
            kind: 'message',
            platform: 'instagram',
            platformId: senderId,
            handle: event.sender?.username,
            displayName: event.sender?.name,
            id: message.mid,
            threadId: `ig:${senderId}`,
            text: message.text ?? describeAttachments(message.attachments),
            occurredAt: event.timestamp,
            payload: event,
          }),
        );
      }
    }
    lastEventAt = events.at(-1)?.occurredAt ?? lastEventAt;
    return events;
  }

  return {
    name: 'graph-api',
    mode: 'push',

    async push(payload) {
      return handleWebhookPayload(payload);
    },
    handleWebhookPayload,

    /**
     * Sweep conversations. Used as a safety net behind the webhook, not as the
     * primary path — polling every thread burns rate limit for little gain when
     * webhooks are healthy.
     */
    async poll() {
      if (!accountId || !pageAccessToken) return [];
      lastPolledAt = new Date().toISOString();

      const conversations = await graph(`${accountId}/conversations`, {
        platform: 'instagram',
        fields: `participants,updated_time,messages.limit(${pageSize}){id,created_time,from,to,message}`,
        limit: pageSize,
      });

      /** @type {import('../core/types.js').RawEvent[]} */
      const events = [];
      for (const conversation of conversations.data ?? []) {
        if (sinceCursor && conversation.updated_time && conversation.updated_time <= sinceCursor) continue;

        for (const message of conversation.messages?.data ?? []) {
          const from = message.from ?? {};
          if (!from.id || from.id === accountId) continue;
          events.push(
            makeRawEvent({
              source: 'graph-api',
              kind: 'message',
              platform: 'instagram',
              platformId: from.id,
              handle: from.username,
              displayName: from.name,
              id: message.id,
              threadId: `ig:${from.id}`,
              text: message.message ?? '',
              occurredAt: message.created_time,
              payload: { conversationId: conversation.id, viaPoll: true },
            }),
          );
        }
      }

      const newest = (conversations.data ?? [])
        .map((c) => c.updated_time)
        .filter(Boolean)
        .sort()
        .at(-1);
      if (newest) sinceCursor = newest;
      if (events.length) lastEventAt = events.at(-1).occurredAt;

      logger?.debug?.('graph poll complete', { conversations: conversations.data?.length ?? 0, events: events.length });
      return events;
    },

    async health() {
      if (!accountId || !pageAccessToken) {
        return { status: 'unconfigured', detail: 'IG_ACCOUNT_ID and IG_PAGE_ACCESS_TOKEN are required' };
      }
      try {
        const me = await graph(accountId, { fields: 'id,username' });
        return {
          status: 'ok',
          detail: `connected as @${me.username ?? me.id}`,
          lastEventAt,
          lastPolledAt,
        };
      } catch (err) {
        // A token expiring is the single most common failure in production, and
        // it looks identical to an outage unless the message is surfaced.
        return { status: 'down', detail: String(err.message), lastEventAt, lastPolledAt };
      }
    },
  };
}

function describeAttachments(attachments) {
  if (!attachments?.length) return '';
  return `[sent ${[...new Set(attachments.map((a) => a.type ?? 'attachment'))].join(', ')}]`;
}
