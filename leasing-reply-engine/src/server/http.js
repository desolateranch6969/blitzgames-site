#!/usr/bin/env node
/**
 * HTTP surface: Meta's webhook callback plus a small read-only operations API.
 *
 * Built on node:http with no framework, because this module must stay
 * dependency-free and the routing is six endpoints. When the management portal
 * arrives it can either mount its own server and call `createEngine()` directly,
 * or keep this one and register routes through a module — both work.
 *
 *   GET  /health                     liveness + what is loaded
 *   GET  /webhook/instagram          Meta subscription handshake
 *   POST /webhook/instagram          inbound DMs (HMAC verified)
 *   POST /simulate                   {"text": "...", "threadId": "..."} -> composed reply
 *   GET  /conversations              recent threads (summaries)
 *   GET  /conversations/:threadId    one thread with its full transcript
 */
import { createServer } from 'node:http';
import { createEngine } from '../index.js';
import { createInstagramChannel } from '../channels/instagram.js';
import { summarizeLead } from '../domain/conversation.js';

/**
 * @param {{engine?: any, port?: number, instagram?: any}} [options]
 */
export function createHttpServer(options = {}) {
  const engine =
    options.engine ??
    createEngine({
      logLevel: process.env.LOG_LEVEL ?? 'info',
      voiceProfile: process.env.VOICE_PROFILE,
      realizer: process.env.REALIZER === 'llm' ? 'llm' : 'template',
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      llmModel: process.env.LLM_MODEL,
      store: process.env.STORE === 'file' ? 'file' : 'memory',
      storePath: process.env.STORE_PATH,
      dryRun: process.env.DRY_RUN === '1',
      maxMessagesPerThreadPerHour: Number(process.env.MAX_MESSAGES_PER_THREAD_PER_HOUR) || 12,
      business: {
        agentName: process.env.AGENT_NAME ?? 'me',
        hours: {
          quietStart: Number(process.env.QUIET_HOURS_START ?? 21),
          quietEnd: Number(process.env.QUIET_HOURS_END ?? 8),
          timezone: process.env.TIMEZONE,
        },
      },
    });

  const instagram = options.instagram ?? createInstagramChannel({ logger: engine.logger.child('instagram') });
  engine.addChannel(instagram);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === 'GET /health') {
        return json(res, 200, {
          ok: true,
          voice: engine.profile.id,
          realizer: engine.realizerName,
          modules: engine.modules(),
          capabilities: engine.capabilities(),
        });
      }

      if (route === 'GET /webhook/instagram') {
        const query = Object.fromEntries(url.searchParams.entries());
        const result = instagram.verifySubscription(query);
        res.writeHead(result.status, { 'content-type': 'text/plain' });
        return res.end(result.body);
      }

      if (route === 'POST /webhook/instagram') {
        // The signature is computed over the exact bytes received, so the raw
        // body must reach the adapter unparsed.
        const rawBody = await readRawBody(req);
        const result = await instagram.handleWebhook({
          rawBody,
          signature: String(req.headers['x-hub-signature-256'] ?? ''),
        });
        return json(res, result.status, { received: result.results?.length ?? 0, error: result.error });
      }

      if (route === 'POST /simulate') {
        const body = JSON.parse((await readRawBody(req)).toString('utf8') || '{}');
        if (!body.text) return json(res, 400, { error: 'text is required' });
        const result = await engine.handle({
          id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel: body.channel ?? 'console',
          threadId: body.threadId ?? 'simulate:1',
          senderId: body.senderId ?? 'simulate-user',
          senderName: body.name,
          text: body.text,
          receivedAt: Date.now(),
        });
        return json(res, 200, {
          parts: result.outbound?.parts ?? [],
          acts: result.outbound?.meta.speechActs ?? [],
          sent: result.sent,
          reason: result.reason,
          violations: result.violations ?? [],
          lead: summarizeLead(result.conversation),
        });
      }

      if (route === 'GET /conversations') {
        const list = await engine.store.list({
          status: url.searchParams.get('status') ?? undefined,
          stage: url.searchParams.get('stage') ?? undefined,
          limit: Number(url.searchParams.get('limit')) || 50,
        });
        return json(res, 200, { conversations: list.map(summarizeLead) });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/conversations/')) {
        const threadId = decodeURIComponent(url.pathname.slice('/conversations/'.length));
        const convo = await engine.store.get(threadId);
        if (!convo) return json(res, 404, { error: 'not found' });
        return json(res, 200, { summary: summarizeLead(convo), conversation: convo });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      engine.logger.error('request failed', { route, error: String(err?.stack ?? err) });
      return json(res, 500, { error: 'internal error' });
    }
  });

  return {
    server,
    engine,
    instagram,
    async listen(port = options.port ?? (Number(process.env.PORT) || 3000)) {
      await engine.start();
      await new Promise((resolve) => server.listen(port, resolve));
      engine.logger.info('http server listening', { port });
      return server;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await engine.stop();
    },
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body ?? {}, null, 2);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/** @param {import('node:http').IncomingMessage} req */
function readRawBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Run directly: `npm run serve`
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createHttpServer();
  await app.listen();
}
