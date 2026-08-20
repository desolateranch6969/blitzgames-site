/**
 * Instagram channel adapter (Meta Messenger Platform, Instagram messaging).
 *
 * Three responsibilities, and nothing else:
 *   1. Prove a webhook really came from Meta (subscription handshake + HMAC).
 *   2. Translate Meta's payload shape into the engine's InboundMessage.
 *   3. Send text back through the Graph API, pacing the bubbles.
 *
 * No leasing logic lives here. That is the point of the adapter boundary: when
 * SMS, WhatsApp, email, or a web widget gets added, they implement this same
 * three-method shape and the engine does not change.
 *
 * Setup, for whoever wires the Meta app:
 *   - An Instagram professional account linked to a Facebook Page.
 *   - A Meta app with Instagram messaging, subscribed to the `messages` field.
 *   - Permissions: instagram_basic, instagram_manage_messages, pages_manage_metadata.
 *   - A public HTTPS callback URL and a verify token you choose (IG_VERIFY_TOKEN).
 *   - The app's privacy policy and terms URLs, which Meta requires at review.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_GRAPH_VERSION = 'v21.0';

/**
 * @param {{
 *   accountId?: string,
 *   pageAccessToken?: string,
 *   appSecret?: string,
 *   verifyToken?: string,
 *   graphVersion?: string,
 *   respectDelays?: boolean,
 *   fetchImpl?: typeof fetch,
 *   logger?: any,
 * }} [options]
 */
export function createInstagramChannel(options = {}) {
  const {
    accountId = process.env.IG_ACCOUNT_ID,
    pageAccessToken = process.env.IG_PAGE_ACCESS_TOKEN,
    appSecret = process.env.IG_APP_SECRET,
    verifyToken = process.env.IG_VERIFY_TOKEN,
    graphVersion = process.env.IG_GRAPH_VERSION || DEFAULT_GRAPH_VERSION,
    respectDelays = true,
    fetchImpl = globalThis.fetch,
  } = options;

  let logger = options.logger;
  /** @type {any} */
  let engine = null;

  return {
    name: 'instagram',

    async start(ctx) {
      engine = ctx.engine;
      logger = ctx.logger ?? logger;
      if (!pageAccessToken || !accountId) {
        logger?.warn('instagram adapter started without credentials; it can receive but not send');
      }
    },

    /**
     * Meta's subscription handshake (GET on the callback URL).
     * @param {Record<string, string>} query
     * @returns {{status: number, body: string}}
     */
    verifySubscription(query) {
      const mode = query['hub.mode'];
      const token = query['hub.verify_token'];
      const challenge = query['hub.challenge'];
      if (mode === 'subscribe' && verifyToken && token === verifyToken) {
        return { status: 200, body: String(challenge ?? '') };
      }
      return { status: 403, body: 'verification failed' };
    },

    /**
     * Validate X-Hub-Signature-256 against the raw request body.
     *
     * This must run on the exact bytes received, before any JSON parsing —
     * re-serializing changes the digest. Without a configured app secret the
     * check is skipped and loudly logged, because an unauthenticated public
     * webhook accepts messages from anyone.
     *
     * @param {Buffer|string} rawBody
     * @param {string} signatureHeader
     */
    verifySignature(rawBody, signatureHeader) {
      if (!appSecret) {
        logger?.warn('IG_APP_SECRET is not set; webhook signatures are not being verified');
        return true;
      }
      if (!signatureHeader?.startsWith('sha256=')) return false;

      const expected = createHmac('sha256', appSecret)
        .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8'))
        .digest('hex');
      const received = signatureHeader.slice('sha256='.length);

      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(received, 'utf8');
      return a.length === b.length && timingSafeEqual(a, b);
    },

    /**
     * Translate a webhook payload into inbound messages.
     * @param {any} payload
     * @returns {import('../core/types.js').InboundMessage[]}
     */
    parseWebhook(payload) {
      /** @type {import('../core/types.js').InboundMessage[]} */
      const messages = [];
      if (payload?.object !== 'instagram' && payload?.object !== 'page') return messages;

      for (const entry of payload.entry ?? []) {
        for (const event of entry.messaging ?? entry.changes ?? []) {
          const message = event.message ?? event.value?.message;
          if (!message) continue;

          // Echoes are our own outbound messages coming back. Replying to them
          // is an infinite loop with a real person watching.
          if (message.is_echo) continue;
          if (message.is_deleted || message.is_unsupported) continue;

          const senderId = event.sender?.id ?? event.value?.sender?.id;
          if (!senderId || senderId === accountId) continue;

          messages.push({
            id: message.mid ?? `${senderId}:${event.timestamp ?? Date.now()}`,
            channel: 'instagram',
            threadId: `ig:${senderId}`,
            senderId,
            senderName: event.sender?.name,
            senderHandle: event.sender?.username,
            text: message.text ?? describeAttachments(message.attachments),
            attachments: (message.attachments ?? []).map((a) => ({ type: a.type ?? 'unknown', url: a.payload?.url })),
            receivedAt: event.timestamp ?? Date.now(),
            raw: event,
          });
        }
      }
      return messages;
    },

    /**
     * Full inbound path: verify, parse, hand each message to the engine.
     * @param {{rawBody: Buffer|string, signature?: string}} request
     */
    async handleWebhook({ rawBody, signature }) {
      if (!this.verifySignature(rawBody, signature ?? '')) {
        return { status: 403, results: [], error: 'invalid signature' };
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
      } catch {
        return { status: 400, results: [], error: 'invalid json' };
      }

      const inbound = this.parseWebhook(payload);
      const results = [];
      for (const message of inbound) {
        try {
          results.push(await engine.handle(message));
        } catch (err) {
          logger?.error('failed handling inbound message', { id: message.id, error: String(err?.stack ?? err) });
        }
      }
      // Meta retries anything that is not a fast 200, so acknowledge even when
      // an individual message failed — the error is ours to fix, not theirs.
      return { status: 200, results };
    },

    /**
     * @param {import('../core/types.js').OutboundMessage} outbound
     */
    async send(outbound) {
      if (!pageAccessToken || !accountId) {
        throw new Error('cannot send: IG_PAGE_ACCESS_TOKEN and IG_ACCOUNT_ID are required');
      }
      const recipientId = outbound.threadId.replace(/^ig:/, '');
      const url = `https://graph.facebook.com/${graphVersion}/${accountId}/messages`;
      const sentIds = [];

      for (const [index, text] of outbound.parts.entries()) {
        if (respectDelays && index > 0) {
          await sleep(Math.min(outbound.delaysMs?.[index] ?? 0, 8000));
        }

        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${pageAccessToken}`,
          },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text },
          }),
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`instagram send failed (${response.status}): ${detail.slice(0, 300)}`);
        }
        const body = await response.json().catch(() => ({}));
        sentIds.push(body.message_id ?? null);
      }

      logger?.info('sent instagram reply', { threadId: outbound.threadId, parts: outbound.parts.length });
      return { sentIds };
    },
  };
}

/** Give the classifier something to work with when a lead sends only media. */
function describeAttachments(attachments) {
  if (!attachments?.length) return '';
  const kinds = [...new Set(attachments.map((a) => a.type ?? 'attachment'))];
  return `[sent ${kinds.join(', ')}]`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
