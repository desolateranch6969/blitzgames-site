import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine, EVENTS } from '../src/index.js';
import { createConsoleChannel } from '../src/channels/console.js';
import { createInstagramChannel } from '../src/channels/instagram.js';
import { createListingsModule } from '../examples/modules/listings-module.js';
import { createLeadLogModule } from '../examples/modules/lead-log-module.js';
import { createHmac } from 'node:crypto';

function engineWith(config = {}) {
  return createEngine({
    logLevel: 'silent',
    respectQuietHours: false,
    business: { agentName: 'me' },
    ...config,
  });
}

let counter = 0;
function inbound(text, threadId = 'test:1', extra = {}) {
  return {
    id: `msg-${++counter}`,
    channel: 'console',
    threadId,
    senderId: 'lead-1',
    text,
    receivedAt: Date.now(),
    ...extra,
  };
}

describe('a full conversation', () => {
  test('qualifies a lead over several turns and asks one thing at a time', async () => {
    const engine = engineWith();
    const thread = 'flow:1';

    const first = await engine.handle(inbound('hey saw your reel, looking for a 2 bed in uptown', thread));
    assert.ok(first.outbound.parts.length >= 1);
    assert.ok(first.outbound.meta.speechActs.includes('greet'), 'the first reply says hello');
    assert.equal(countQuestions(first.outbound.parts), 1, 'exactly one question per reply');

    await engine.handle(inbound('budget is around 2k', thread));
    const third = await engine.handle(inbound('moving september 1st', thread));

    const convo = await engine.store.get(thread);
    assert.equal(convo.slots.beds, 2);
    assert.equal(convo.slots.budget.max, 2000);
    assert.deepEqual(convo.slots.areas, ['uptown']);
    assert.equal(convo.slots.moveIn.iso.slice(5), '09-01');
    assert.equal(convo.stage, 'qualified');
    assert.ok(third.outbound);
  });

  test('answers the question asked before asking its own', async () => {
    const engine = engineWith();
    const result = await engine.handle(inbound('do you charge anything?', 'fee:1'));
    const acts = result.outbound.meta.speechActs;
    assert.ok(acts.includes('answer.fee'));
    assert.ok(acts.indexOf('answer.fee') < acts.findIndex((a) => a.startsWith('ask.')), 'answer first, then ask');
  });

  test('a retried webhook does not produce a second reply', async () => {
    const engine = engineWith();
    const message = inbound('hey there', 'dupe:1');
    const first = await engine.handle(message);
    const second = await engine.handle(message);
    assert.ok(first.outbound);
    assert.equal(second.outbound, null);
    assert.equal(second.reason, 'duplicate');
  });

  test('the same message on a fresh thread gets the same reply', async () => {
    const a = engineWith();
    const b = engineWith();
    const first = await a.handle(inbound('hey looking for a 1 bed', 'same-thread'));
    const second = await b.handle(inbound('hey looking for a 1 bed', 'same-thread'));
    assert.deepEqual(first.outbound.parts, second.outbound.parts);
  });

  test('different leads do not get identical scripts', async () => {
    const engine = engineWith();
    const replies = new Set();
    for (let i = 0; i < 8; i++) {
      const result = await engine.handle(inbound('hey looking for a 1 bed', `lead-${i}`));
      replies.add(result.outbound.parts.join('|'));
    }
    assert.ok(replies.size > 3, `expected varied openings, got ${replies.size}`);
  });
});

describe('compliance behavior', () => {
  test('a steering question gets a neutral answer and a human, never a sales reply', async () => {
    const engine = engineWith();
    const flagged = [];
    engine.bus.on(EVENTS.COMPLIANCE_FLAGGED, (payload) => flagged.push(payload));

    const result = await engine.handle(inbound('is that a safe area for my family?', 'fh:1'));

    assert.ok(result.outbound, 'it still replies');
    assert.ok(result.outbound.meta.speechActs.includes('compliance.steering'));
    assert.ok(result.outbound.meta.speechActs.includes('handoff.human'));
    assert.match(result.outbound.parts.join(' '), /fair housing/i);
    assert.equal(result.conversation.status, 'awaiting_human');
    assert.ok(flagged.length > 0);

    // And it must not have answered the question in any form.
    assert.doesNotMatch(result.outbound.parts.join(' '), /\b(safe|dangerous|good area|nice area)\b/);
  });

  test('an assistance animal is never handled as a pet', async () => {
    const engine = engineWith();
    const result = await engine.handle(inbound('i have an esa dog, is that a problem?', 'esa:1'));
    assert.ok(result.outbound.meta.speechActs.includes('compliance.assistance_animal'));
    assert.match(result.outbound.parts.join(' '), /not.*(a )?pet|no pet rent/i);
    assert.equal(result.conversation.status, 'awaiting_human');
  });

  test('a discrimination claim is never answered automatically', async () => {
    const engine = engineWith();
    const result = await engine.handle(inbound('i think they discriminated against me', 'legal:1'));
    assert.equal(result.outbound, null);
    assert.equal(result.conversation.status, 'awaiting_human');
  });

  test('opting out stops the thread for good', async () => {
    const engine = engineWith();
    const thread = 'stop:1';
    const first = await engine.handle(inbound('stop messaging me', thread));
    assert.ok(first.outbound.meta.speechActs.includes('optout.ack'));
    assert.equal(first.conversation.status, 'opted_out');

    const second = await engine.handle(inbound('actually wait, do you have 2 beds?', thread));
    assert.equal(second.outbound, null, 'an opted-out thread stays silent');
  });

  test('spam gets no reply at all', async () => {
    const engine = engineWith();
    const result = await engine.handle(inbound('want to grow your following? dm me for crypto', 'spam:1'));
    assert.equal(result.outbound, null);
  });

  test('asking for a human hands the thread over', async () => {
    const engine = engineWith();
    const asked = [];
    engine.bus.on(EVENTS.HUMAN_REQUESTED, (p) => asked.push(p));
    const result = await engine.handle(inbound('is this a bot? i want to talk to a real person', 'human:1'));
    assert.ok(result.outbound.meta.speechActs.includes('handoff.human'));
    assert.equal(result.conversation.status, 'awaiting_human');
    assert.equal(asked.length, 1);
  });

  test('a thread a human took over is not replied to again', async () => {
    const engine = engineWith();
    const thread = 'owned:1';
    await engine.handle(inbound('can you just call me', thread));
    const next = await engine.handle(inbound('also do you have 2 beds?', thread));
    assert.equal(next.outbound, null);
    assert.match(next.reason, /human/);
  });
});

describe('pacing and delivery', () => {
  test('quiet hours hold the reply instead of dropping it', async () => {
    const engine = engineWith({
      respectQuietHours: true,
      business: { agentName: 'me', hours: { quietStart: 0, quietEnd: 24, timezone: 'UTC' } },
    });
    const held = [];
    engine.bus.on(EVENTS.REPLY_HELD, (p) => held.push(p));

    const result = await engine.handle(inbound('hey you there?', 'quiet:1'));
    assert.equal(result.sent, false);
    assert.ok(result.outbound, 'the reply is composed and kept');
    assert.match(result.reason, /quiet hours/);
    assert.equal(held.length, 1);
    assert.ok(result.conversation.flags.heldReply);
  });

  test('the per-thread rate limit stops a runaway loop', async () => {
    const engine = engineWith({ maxMessagesPerThreadPerHour: 2 });
    const thread = 'flood:1';
    await engine.handle(inbound('hey', thread));
    await engine.handle(inbound('you there?', thread));
    const third = await engine.handle(inbound('hello?', thread));
    assert.equal(third.sent, false);
    assert.match(third.reason, /thread limit/);
  });

  test('dry run composes without delivering', async () => {
    const engine = engineWith({ dryRun: true });
    const channel = createConsoleChannel({ write: () => {} });
    engine.addChannel(channel);
    const result = await engine.handle(inbound('hey looking for a studio', 'dry:1'));
    assert.ok(result.outbound.parts.length);
    assert.equal(result.sent, false);
    assert.equal(channel.sent.length, 0);
  });

  test('approval mode marks replies rather than sending them', async () => {
    const engine = engineWith({ autoSend: false });
    const result = await engine.handle(inbound('hey', 'approve:1'));
    assert.equal(result.sent, false);
    assert.equal(result.outbound.meta.requiresApproval, true);
  });

  test('replies go out through the registered channel', async () => {
    const engine = engineWith();
    const channel = createConsoleChannel({ write: () => {} });
    engine.addChannel(channel);
    const result = await engine.handle(inbound('hey, 2 bed please', 'send:1'));
    assert.equal(result.sent, true);
    assert.equal(channel.sent.length, 1);
  });
});

describe('module system', () => {
  test('capabilities upgrade the reply without changing the engine', async () => {
    const bare = engineWith();
    const withListings = engineWith();
    withListings.use(createListingsModule());

    const script = ['looking for a 2 bed in uptown', 'budget 2k, moving september 1', 'send me some options'];

    const bareReplies = [];
    const richReplies = [];
    for (const text of script) {
      bareReplies.push((await bare.handle(inbound(text, 'bare:1'))).outbound);
      richReplies.push((await withListings.handle(inbound(text, 'rich:1'))).outbound);
    }

    const bareActs = bareReplies.flatMap((o) => o?.meta.speechActs ?? []);
    const richActs = richReplies.flatMap((o) => o?.meta.speechActs ?? []);

    assert.ok(bareActs.includes('answer.listings.promise'), 'alone, it promises to send a list');
    assert.ok(richActs.includes('answer.listings.results'), 'with a listings module, it sends real units');
    assert.match(richReplies.at(-1).parts.join(' '), /The Maple|Lark House/);
  });

  test('a module that throws degrades the reply instead of breaking it', async () => {
    const engine = engineWith();
    engine.use({
      name: 'broken-listings',
      provides: ['listings.search'],
      setup(ctx) {
        ctx.provide('listings.search', async () => {
          throw new Error('upstream is down');
        });
      },
    });
    const result = await engine.handle(inbound('can you send me some options?', 'broken:1'));
    assert.ok(result.outbound, 'a failing bolt-on must never silence a reply');
    assert.ok(result.outbound.meta.speechActs.includes('answer.listings.promise'));
  });

  test('modules observe the conversation through events', async () => {
    const engine = engineWith();
    const captured = [];
    engine.use(createLeadLogModule({ onLead: (record) => captured.push(record) }));

    const thread = 'events:1';
    await engine.handle(inbound('2 bed in uptown, budget 2k, moving sept 1', thread));
    assert.ok(captured.some((c) => c.event === 'qualified'));

    await engine.handle(inbound('can i tour this weekend?', thread));
    assert.ok(captured.some((c) => c.event === 'tour_requested'));
  });

  test('hooks can hold a reply before it is sent', async () => {
    const engine = engineWith();
    engine.use({
      name: 'approval-gate',
      setup() {
        return {
          hooks: {
            beforeSend: (turn) => {
              if (turn.conversation.slots.budget?.max > 5000) turn.scratch.cancelSend = true;
            },
          },
        };
      },
    });
    const cheap = await engine.handle(inbound('looking for a 1 bed under 1500', 'gate:1'));
    const rich = await engine.handle(inbound('looking for a penthouse under 9000', 'gate:2'));
    assert.equal(cheap.sent === false && cheap.outbound !== null, true);
    assert.equal(rich.outbound !== null, true);
    assert.match(rich.reason, /cancelled by module/);
  });

  test('a module declaring an unmet requirement fails loudly at startup', async () => {
    const engine = engineWith();
    engine.use({ name: 'needs-crm', requires: ['crm.push'], setup() {} });
    await assert.rejects(() => engine.start(), /unavailable capabilities: crm\.push/);
  });

  test('modules are ordered so dependencies resolve', async () => {
    const engine = engineWith();
    const order = [];
    engine.use({
      name: 'consumer',
      requires: ['thing'],
      setup(ctx) {
        order.push('consumer');
        assert.equal(ctx.capability('thing')(), 42);
      },
    });
    engine.use({
      name: 'producer',
      provides: ['thing'],
      setup(ctx) {
        order.push('producer');
        ctx.provide('thing', () => 42);
      },
    });
    await engine.start();
    assert.deepEqual(order, ['producer', 'consumer']);
  });

  test('two modules cannot claim the same capability', async () => {
    const engine = engineWith();
    engine.use(createListingsModule());
    engine.use({ ...createListingsModule(), name: 'other-listings' });
    await assert.rejects(() => engine.start(), /already provided/);
  });
});

describe('instagram adapter', () => {
  const APP_SECRET = 'test-secret';

  function signed(payload) {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = 'sha256=' + createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
    return { rawBody, signature };
  }

  function webhookPayload(text, { mid = 'mid-1', senderId = 'ig-user-1', echo = false } = {}) {
    return {
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: senderId },
              recipient: { id: 'ig-account' },
              timestamp: Date.now(),
              message: { mid, text, is_echo: echo || undefined },
            },
          ],
        },
      ],
    };
  }

  test('the subscription handshake echoes the challenge only for the right token', () => {
    const ig = createInstagramChannel({ verifyToken: 'correct' });
    assert.deepEqual(ig.verifySubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'correct', 'hub.challenge': '12345' }), {
      status: 200,
      body: '12345',
    });
    assert.equal(ig.verifySubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }).status, 403);
  });

  test('a tampered body fails signature verification', () => {
    const ig = createInstagramChannel({ appSecret: APP_SECRET });
    const { rawBody, signature } = signed(webhookPayload('hey'));
    assert.equal(ig.verifySignature(rawBody, signature), true);
    assert.equal(ig.verifySignature(Buffer.concat([rawBody, Buffer.from(' ')]), signature), false);
    assert.equal(ig.verifySignature(rawBody, 'sha256=deadbeef'), false);
    assert.equal(ig.verifySignature(rawBody, ''), false);
  });

  test('our own echoed messages never trigger a reply', () => {
    const ig = createInstagramChannel({ appSecret: APP_SECRET, accountId: 'ig-account' });
    assert.equal(ig.parseWebhook(webhookPayload('hi', { echo: true })).length, 0);
    assert.equal(ig.parseWebhook(webhookPayload('hi', { senderId: 'ig-account' })).length, 0);
    assert.equal(ig.parseWebhook(webhookPayload('hi')).length, 1);
  });

  test('a webhook message flows all the way to a composed reply', async () => {
    const engine = engineWith();
    const sent = [];
    const ig = createInstagramChannel({
      appSecret: APP_SECRET,
      accountId: 'ig-account',
      pageAccessToken: 'token',
      respectDelays: false,
      fetchImpl: async (url, options) => {
        sent.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ message_id: 'sent-1' }) };
      },
    });
    engine.addChannel(ig);
    await engine.start();

    const { rawBody, signature } = signed(webhookPayload('hey, looking for a 2 bed in uptown'));
    const result = await ig.handleWebhook({ rawBody, signature });

    assert.equal(result.status, 200);
    assert.equal(result.results.length, 1);
    assert.ok(sent.length >= 1, 'a message went out through the Graph API');
    assert.equal(sent[0].recipient.id, 'ig-user-1');
    assert.ok(sent[0].message.text.length > 0);
  });

  test('an unsigned webhook is rejected before anything is processed', async () => {
    const engine = engineWith();
    const ig = createInstagramChannel({ appSecret: APP_SECRET });
    engine.addChannel(ig);
    await engine.start();
    const result = await ig.handleWebhook({ rawBody: JSON.stringify(webhookPayload('hi')), signature: 'sha256=nope' });
    assert.equal(result.status, 403);
  });

  test('media-only messages still produce something to classify', () => {
    const ig = createInstagramChannel({ appSecret: APP_SECRET, accountId: 'ig-account' });
    const payload = webhookPayload(undefined);
    payload.entry[0].messaging[0].message.attachments = [{ type: 'image', payload: { url: 'http://x/y.jpg' } }];
    const parsed = ig.parseWebhook(payload);
    assert.equal(parsed.length, 1);
    assert.match(parsed[0].text, /image/);
  });
});

function countQuestions(parts) {
  return (parts.join(' ').match(/\?/g) ?? []).length;
}
