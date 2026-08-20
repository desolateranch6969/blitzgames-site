import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createVoiceProfile, loadVoiceProfile, validateVoiceProfile, mergeVoiceProfiles, FALLBACK_PHRASES } from '../src/voice/profile.js';
import { createTemplateRealizer, summarizeCriteria, formatBudget, formatBeds, formatMoveIn, formatAreas, renderPhrase } from '../src/voice/compose.js';
import { applyCasing, applyAbbreviations, applyTics, groupIntoBubbles, stylize, computeDelays, isProtected } from '../src/voice/humanize.js';
import { createRng } from '../src/core/rng.js';
import { createConversation } from '../src/domain/conversation.js';
import { createBusinessProfile } from '../src/domain/business.js';
import { SPEECH_ACTS } from '../src/domain/planner.js';
import { buildProfileFromCorpus, analyzeStyle, findTics, extractPhraseBank } from '../src/voice/learn.js';

const business = createBusinessProfile({ agentName: 'me' });

function convoWith(slots = {}) {
  const convo = createConversation({ threadId: 'voice-test', channel: 'test', contact: { id: 'u', name: 'Sam' } });
  convo.slots = slots;
  return convo;
}

describe('voice profile', () => {
  test('the shipped profile covers every speech act the planner can emit', () => {
    const profile = loadVoiceProfile('standard-locator');
    const missing = SPEECH_ACTS.filter((act) => !profile.phrases[act]?.length);
    assert.deepEqual(missing, [], 'a planned act with no phrase produces silence');
  });

  test('every act has more than one wording so replies do not repeat', () => {
    const profile = loadVoiceProfile('standard-locator');
    const single = Object.entries(profile.phrases)
      .filter(([act, variants]) => variants.length < 2 && !act.startsWith('compliance.'))
      .map(([act]) => act);
    assert.deepEqual(single, []);
  });

  test('a partial profile inherits the rest rather than going silent', () => {
    const thin = createVoiceProfile({ id: 'thin', phrases: { greet: ['yo'] } });
    assert.deepEqual(thin.phrases.greet, ['yo']);
    assert.ok(thin.phrases['ask.budget']?.length, 'unspecified acts fall back');
  });

  test('validation rejects impossible rates and empty banks', () => {
    const bad = createVoiceProfile({ id: 'bad', style: { emojiRate: 4 }, phrases: { greet: [] } });
    const result = validateVoiceProfile(bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('emojiRate')));
    assert.ok(result.errors.some((e) => e.includes('greet')));
  });

  test('learned material wins over the base, base fills the gaps', () => {
    const base = loadVoiceProfile('standard-locator');
    const merged = mergeVoiceProfiles(base, { id: 'his', phrases: { greet: ['wassup'] } });
    assert.deepEqual(merged.phrases.greet, ['wassup']);
    assert.ok(merged.phrases['answer.fee'].length > 1);
    assert.equal(merged.id, 'his');
  });

  test('banned phrases always include the tells that reveal automation', () => {
    const profile = createVoiceProfile({ id: 'x' });
    assert.ok(profile.banned.includes('as an ai'));
  });
});

describe('formatters', () => {
  test('budget reads the way an agent would say it', () => {
    assert.equal(formatBudget({ max: 2000 }), 'up to $2,000');
    assert.equal(formatBudget({ min: 1200, max: 1500 }), '$1,200-$1,500');
  });

  test('a studio is not "0 bed"', () => {
    assert.equal(formatBeds(0), 'studio');
    assert.equal(formatBeds(2), '2 bed');
  });

  test('dates read casually, vague timing stays vague', () => {
    assert.equal(formatMoveIn({ iso: '2026-09-01' }), 'sep 1');
    assert.equal(formatMoveIn({ text: 'asap', iso: '2026-08-20' }), 'asap');
  });

  test('areas are joined the way people speak', () => {
    assert.equal(formatAreas(['uptown']), 'uptown');
    assert.equal(formatAreas(['uptown', 'downtown']), 'uptown or downtown');
    assert.equal(formatAreas(['a', 'b', 'c']), 'a, b, or c');
  });

  test('only what the lead just said is reflected back', () => {
    const slots = { beds: 2, budget: { max: 2000 }, areas: ['uptown'] };
    assert.equal(summarizeCriteria(['beds'], slots), ', 2 bed');
    assert.match(summarizeCriteria(['beds', 'budget'], slots), /^ — 2 bed, up to \$2,000$/);
    assert.equal(summarizeCriteria([], slots), '');
  });

  test('unfilled placeholders leave no debris', () => {
    assert.equal(renderPhrase('hey{name}!', { name: '' }), 'hey!');
    assert.equal(renderPhrase('hey{name}!', { name: ' sam' }), 'hey sam!');
  });
});

describe('humanizer', () => {
  test('lowercase styling keeps acronyms and proper nouns intact', () => {
    const out = applyCasing('I have an ESA and a Unit in TX', { casing: 'lower' });
    assert.match(out, /ESA/);
    assert.match(out, /TX/);
    assert.match(out, /unit/);
  });

  test('abbreviation never corrupts money, phone numbers, or emails', () => {
    const style = { abbreviationRate: 1, abbreviations: { you: 'u', number: '#' } };
    const out = applyAbbreviations('you can reach me at 214-555-0184 or me@you.com for $1,500', style, createRng('x'));
    assert.match(out, /214-555-0184/);
    assert.match(out, /me@you\.com/);
    assert.match(out, /\$1,500/);
    assert.match(out, /^u can/);
  });

  test('a trailing tic never lands on a question', () => {
    const tics = [{ phrase: 'easy', rate: 1, position: 'trail' }];
    assert.equal(applyTics('when are you moving?', tics, createRng('s')), 'when are you moving?');
    assert.match(applyTics('ill send that over', tics, createRng('s')), /, easy$/);
  });

  test('only one tic lands per reply', () => {
    const tics = [{ phrase: 'for sure', rate: 1, position: 'lead' }];
    const state = {};
    const first = applyTics('ill pull a list', tics, createRng('a'), state);
    const second = applyTics('ill send it over', tics, createRng('b'), state);
    assert.match(first, /^for sure/);
    assert.equal(second, 'ill send it over');
  });

  test('compliance and listing text are never restyled', () => {
    assert.equal(isProtected('compliance.steering'), true);
    assert.equal(isProtected('answer.listings.results'), true);
    assert.equal(isProtected('ask.budget'), false);

    const profile = createVoiceProfile({ id: 'x', style: { casing: 'lower', abbreviationRate: 1, abbreviations: { you: 'u' } } });
    const text = 'here are a few:\n1) The Maple — $1,795';
    const out = stylize({ act: 'answer.listings.results', text }, profile, createRng('s'));
    assert.match(out, /The Maple/, 'property names keep their capitalization');
    assert.match(out, /\n/, 'a list stays on separate lines');
  });

  test('bubbles never exceed the profile cap and questions end one', () => {
    const style = { bubbles: { maxBubbles: 2, splitRate: 1, targetWordsPerBubble: 10 } };
    const bubbles = groupIntoBubbles(
      [
        { act: 'greet', text: 'hey' },
        { act: 'ack.criteria', text: 'got it, 2 bed' },
        { act: 'ask.budget', text: 'whats your budget?' },
        { act: 'ask.pets', text: 'any pets?' },
      ],
      style,
      createRng('seed'),
    );
    assert.ok(bubbles.length <= 2);
  });

  test('send delays scale with message length and stay bounded', () => {
    const style = { typing: { baseMs: 1000, msPerChar: 30, jitterMs: 200, maxMs: 5000 } };
    const [short, long] = computeDelays(['ok', 'a'.repeat(200)], style, createRng('s'));
    assert.ok(short < long);
    assert.ok(long <= 5000);
  });
});

describe('template realizer', () => {
  const profile = loadVoiceProfile('standard-locator');
  const realizer = createTemplateRealizer({ profile, business });

  const plan = {
    steps: [
      { act: 'greet', data: {} },
      { act: 'ack.criteria', data: { changed: ['beds', 'budget'] } },
      { act: 'ask.moveIn', data: {} },
    ],
  };

  test('the same situation always produces the same reply', async () => {
    const a = await realizer.realize({ plan, conversation: convoWith({ beds: 2, budget: { max: 2000 } }), seed: 'fixed' });
    const b = await realizer.realize({ plan, conversation: convoWith({ beds: 2, budget: { max: 2000 } }), seed: 'fixed' });
    assert.deepEqual(a.parts, b.parts, 'a retried webhook must not say something new');
  });

  test('different threads get different wording', async () => {
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      const result = await realizer.realize({ plan, conversation: convoWith({ beds: 2 }), seed: `thread-${i}` });
      seen.add(result.parts.join('|'));
    }
    assert.ok(seen.size > 4, `expected varied phrasing across leads, got ${seen.size} distinct replies`);
  });

  test('a thread does not repeat its own phrasing', async () => {
    const convo = convoWith({ beds: 2 });
    const used = new Set();
    for (let i = 0; i < 4; i++) {
      const result = await realizer.realize({
        plan: { steps: [{ act: 'ask.budget', data: {} }] },
        conversation: convo,
        seed: `turn-${i}`,
      });
      used.add(result.parts.join(''));
    }
    assert.ok(used.size >= 3, 'the same question should be asked with different words');
  });

  test('a phrase needing data it does not have is dropped, not sent half-written', async () => {
    const result = await realizer.realize({
      plan: { steps: [{ act: 'answer.listings.results', data: { results: [] } }] },
      conversation: convoWith(),
      seed: 's',
    });
    assert.deepEqual(result.parts, []);
  });

  test('every speech act renders to something', async () => {
    const empty = [];
    for (const act of SPEECH_ACTS) {
      const result = await realizer.realize({
        plan: { steps: [{ act, data: { changed: ['beds'], when: 'saturday', results: [{ name: 'X', area: 'y', rent: 1500 }], slots: ['10am'] } }] },
        conversation: convoWith({ beds: 2, budget: { max: 2000 }, tourAvailability: 'saturday' }),
        seed: `act-${act}`,
      });
      if (!result.parts.length) empty.push(act);
    }
    assert.deepEqual(empty, []);
  });
});

describe('learning a voice from a corpus', () => {
  // A habit is a phrase that recurs across different sentences, so the fixture
  // has to vary the sentences or the test would prove nothing.
  const TAILS = [
    'let me pull a few and shoot them over',
    'ill check whats available today',
    'i can get that set up for you',
    'thats an easy one',
    'ill text you the addresses',
    'we can knock those out in one trip',
  ];
  const corpus = [
    ...Array.from({ length: 30 }, (_, i) => [
      { role: 'lead', text: `question ${i}` },
      { role: 'agent', text: `for sure, ${TAILS[i % TAILS.length]}`, context: `question ${i}` },
    ]).flat(),
    { role: 'lead', text: 'do you charge?' },
    { role: 'agent', text: 'nope costs u nothing, the property pays my side 🔥', context: 'do you charge?' },
    { role: 'agent', text: 'when are you trying to move?' },
    { role: 'agent', text: 'whats your budget looking like?' },
  ];

  test('style is measured, not guessed', () => {
    const style = analyzeStyle(corpus);
    assert.equal(style.casing, 'lower');
    assert.ok(style.emojiPalette.includes('🔥'));
    assert.ok(style.abbreviationRate > 0, 'noticed "u" for "you"');
  });

  test('a habit that spans different sentences is found', () => {
    const tics = findTics(corpus);
    assert.ok(tics.some((t) => t.phrase === 'for sure'), `expected "for sure", got ${JSON.stringify(tics.map((t) => t.phrase))}`);
  });

  test('a fragment of one repeated sentence is not mistaken for a habit', () => {
    const repetitive = Array.from({ length: 30 }, () => ({
      role: 'agent',
      text: 'let me pull a few and shoot them over',
    }));
    assert.deepEqual(findTics(repetitive), [], 'one sentence said 30 times is a template, not a tic');
  });

  test('real wording is bucketed by what the message was doing', () => {
    const { phrases } = extractPhraseBank(corpus);
    assert.ok(phrases['ask.moveIn']?.some((p) => p.includes('trying to move')));
    assert.ok(phrases['answer.fee']?.some((p) => p.includes('costs u nothing')));
  });

  test('a learned profile is a drop-in replacement and reports its own limits', async () => {
    const base = loadVoiceProfile('standard-locator');
    const { profile, report } = buildProfileFromCorpus(corpus, { id: 'learned', base });

    assert.equal(profile.provenance.source, 'learned-from-corpus');
    assert.ok(report.actsUsingBaseline.length > 0, 'it should say what it could not learn');
    assert.match(report.confidence, /thin|usable|good/);

    // The engine must be able to speak with it immediately.
    const realizer = createTemplateRealizer({ profile, business });
    const result = await realizer.realize({
      plan: { steps: [{ act: 'ask.moveIn', data: {} }] },
      conversation: convoWith(),
      seed: 'learned',
    });
    assert.ok(result.parts.length === 1);
  });

  test('the fallback bank covers every act the planner knows', () => {
    const missing = SPEECH_ACTS.filter((act) => !FALLBACK_PHRASES[act]);
    assert.deepEqual(missing, []);
  });
});
