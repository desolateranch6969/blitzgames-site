import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkOutbound, checkInbound, withinQuietHours } from '../src/policy/guardrails.js';
import { createRateLimiter, withinReplyWindow } from '../src/policy/rate-limit.js';
import { createConversation } from '../src/domain/conversation.js';
import { createVoiceProfile } from '../src/voice/profile.js';

const profile = createVoiceProfile({ id: 'test', banned: ['per my last message'] });

function blocked(parts, ctx = {}) {
  return checkOutbound(parts, { profile, ...ctx });
}

describe('fair housing guardrails', () => {
  const steering = [
    'that area is really safe',
    'its a great neighborhood for families',
    'the schools over there are good',
    'its mostly young professionals in that building',
    'this one is adults only',
    'perfect for a christian community',
  ];
  for (const text of steering) {
    test(`blocks: "${text}"`, () => {
      const result = blocked([text]);
      assert.equal(result.blocked, true);
      assert.ok(result.violations.some((v) => v.rule.startsWith('fair_housing')));
    });
  }

  test('blocks questions about protected characteristics', () => {
    const result = blocked(['how many kids do you have?']);
    assert.equal(result.blocked, true);
  });

  test('lets ordinary leasing talk through', () => {
    const fine = [
      'ok cool 2 bed in uptown, up to $2,000',
      'when are you trying to move?',
      'most places want about 3x the rent in gross income',
      'how many people will be on the lease?',
    ];
    for (const text of fine) {
      assert.equal(blocked([text]).blocked, false, `should allow: ${text}`);
    }
  });
});

describe('promise and voice guardrails', () => {
  test('blocks guarantees the property alone controls', () => {
    assert.equal(blocked(['dont worry, guaranteed approval']).blocked, true);
    assert.equal(blocked(['youll be approved for sure']).blocked, true);
  });

  test('blocks anything that reveals automation', () => {
    assert.equal(blocked(['as an ai i cannot do that']).blocked, true);
  });

  test('blocks phrases this voice has banned', () => {
    const result = blocked(['per my last message, the fee is zero']);
    assert.equal(result.blocked, true);
    assert.ok(result.violations.some((v) => v.rule === 'voice.banned_phrase'));
  });

  test('blocks a reply identical to the one just sent', () => {
    const convo = createConversation({ threadId: 't', channel: 'test' });
    convo.turns.push({ role: 'agent', text: 'when are you moving?', at: Date.now() });
    const result = blocked(['when are you moving?'], { conversation: convo });
    assert.equal(result.blocked, true);
    assert.ok(result.violations.some((v) => v.rule === 'duplicate'));
  });

  test('trims over-long messages instead of failing the send', () => {
    const result = blocked(['x'.repeat(1200)]);
    assert.equal(result.blocked, false);
    assert.ok(result.parts[0].length <= 950);
    assert.ok(result.violations.some((v) => v.rule === 'length'));
  });

  test('warns when a reply stacks up questions', () => {
    const result = blocked(['whats your budget? when do you move? any pets?']);
    assert.ok(result.violations.some((v) => v.rule === 'too_many_questions'));
  });
});

describe('inbound screening', () => {
  test('never auto-replies to a discrimination or legal claim', () => {
    const result = checkInbound({ text: 'i think that property discriminated against me' });
    assert.equal(result.allow, false);
    assert.equal(result.escalate, true);
  });

  test('never auto-replies to a safety disclosure', () => {
    const result = checkInbound({ text: 'im leaving a domestic violence situation and need out fast' });
    assert.equal(result.allow, false);
    assert.equal(result.escalate, true);
  });

  test('ignores empty messages', () => {
    assert.equal(checkInbound({ text: '   ' }).allow, false);
  });

  test('allows a normal inquiry', () => {
    assert.equal(checkInbound({ text: 'looking for a 2 bed' }).allow, true);
  });
});

describe('pacing', () => {
  test('quiet hours wrap around midnight', () => {
    const at = (hour) => Date.parse(`2026-08-20T${String(hour).padStart(2, '0')}:00:00Z`);
    const hours = { quietStart: 21, quietEnd: 8, timezone: 'UTC' };
    assert.equal(withinQuietHours(hours, at(23)), true);
    assert.equal(withinQuietHours(hours, at(3)), true);
    assert.equal(withinQuietHours(hours, at(14)), false);
  });

  test('per-thread and per-account limits both apply', () => {
    let now = 0;
    const limiter = createRateLimiter({ perThreadPerHour: 2, perAccountPerMinute: 100, now: () => now });
    assert.equal(limiter.check('a').allowed, true);
    limiter.record('a');
    limiter.record('a');
    assert.equal(limiter.check('a').allowed, false);
    assert.equal(limiter.check('b').allowed, true, 'a different lead is unaffected');

    now += 3_600_001;
    assert.equal(limiter.check('a').allowed, true, 'the window rolls off');
  });

  test('the platform reply window is respected', () => {
    const convo = createConversation({ threadId: 't', channel: 'instagram' });
    convo.lastInboundAt = Date.now() - 25 * 3600_000;
    const result = withinReplyWindow(convo);
    assert.equal(result.ok, false);
    assert.match(result.reason, /outside the 24h reply window/);

    convo.lastInboundAt = Date.now() - 3600_000;
    assert.equal(withinReplyWindow(convo).ok, true);
  });

  test('a thread with no inbound message is never replied to', () => {
    const convo = createConversation({ threadId: 't', channel: 'instagram' });
    assert.equal(withinReplyWindow(convo).ok, false);
  });
});
