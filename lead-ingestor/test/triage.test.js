import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTriage, DISPOSITIONS, ROUTING } from '../src/triage/triage.js';
import { createSignalDetector } from '../src/triage/signals.js';
import {
  normalizeHandle,
  normalizePhone,
  normalizeEmail,
  normalizeLinkedInUrl,
  normalizeWebsite,
  makeIdentifier,
} from '../src/identity/handles.js';
import { createPerson, compareIdentities, mergePeople, addFacts, addIdentifiers } from '../src/identity/identity.js';

const triage = createTriage();

describe('triage produces routing, never a ranking', () => {
  test('the output has no score, grade, rank, or tier field', () => {
    const result = triage.classify({ text: 'looking for a 2 bed in uptown under 2k, moving september 1' });
    const keys = Object.keys(result);
    for (const banned of ['score', 'rank', 'ranking', 'grade', 'tier', 'quality', 'value', 'priority', 'rating']) {
      assert.equal(keys.includes(banned), false, `triage must not expose a "${banned}" field`);
    }
    // `confidence` is about the classifier's own call, and that is the only number.
    assert.deepEqual(
      keys.filter((k) => typeof result[k] === 'number'),
      ['confidence'],
    );
  });

  test('every disposition has a defined next step', () => {
    for (const disposition of Object.values(DISPOSITIONS)) {
      assert.ok(ROUTING[disposition], `${disposition} has no routing`);
      assert.equal(typeof ROUTING[disposition].handOffToReplyEngine, 'boolean');
    }
  });

  test('a decision always carries its reasons', () => {
    for (const text of ['looking for a 1 bed asap', 'grow your following, dm me', 'hey']) {
      const result = triage.classify({ text });
      assert.ok(result.reasons.length > 0, `no reason given for "${text}"`);
    }
  });
});

describe('classifying real inbound', () => {
  const cases = [
    ['hey! saw your reel, looking for a 2 bed in uptown under 2k', DISPOSITIONS.PROSPECTIVE_RENTER],
    ['need a 1 bed asap, budget 1300', DISPOSITIONS.PROSPECTIVE_RENTER],
    ['moving september 1st, around $2000', DISPOSITIONS.PROSPECTIVE_RENTER],
    ['i have a broken lease, can you still help me find a place', DISPOSITIONS.PROSPECTIVE_RENTER],
    ['do you charge anything for this?', DISPOSITIONS.GENERAL_QUESTION],
    ['how does this work?', DISPOSITIONS.GENERAL_QUESTION],
    ['hey', DISPOSITIONS.NEEDS_QUALIFICATION],
    ['my friend said you helped her find a place', DISPOSITIONS.NEEDS_QUALIFICATION],
    ['do you help people buy a house? im pre-approved', DISPOSITIONS.NOT_SERVICEABLE],
    ['im looking for a roommate to split rent with', DISPOSITIONS.NOT_SERVICEABLE],
    ['are you hiring? id love to get into real estate', DISPOSITIONS.NOT_SERVICEABLE],
    ['i have a rental property i need filled', DISPOSITIONS.NOT_SERVICEABLE],
    ['we already signed somewhere, thanks anyway', DISPOSITIONS.NOT_SERVICEABLE],
    ['i can get you more leads with my ai automation service', DISPOSITIONS.VENDOR_OR_RECRUITER],
    ['join our brokerage, great commission split', DISPOSITIONS.VENDOR_OR_RECRUITER],
    ['make $500 a day with bitcoin, dm me', DISPOSITIONS.SPAM_OR_BOT],
    ['happy birthday!! hope youre doing well', DISPOSITIONS.PERSONAL_OR_SOCIAL],
    ['this is a scam, im calling my lawyer', DISPOSITIONS.UNCLEAR],
  ];

  for (const [text, expected] of cases) {
    test(`"${text.slice(0, 46)}…" -> ${expected}`, () => {
      assert.equal(triage.classify({ text }).disposition, expected);
    });
  }

  test('a rental search stated alongside a disqualifier still counts as a search', () => {
    const result = triage.classify({
      text: 'im buying a house next year but i need a rental for now, 1 bed under 1500',
    });
    assert.equal(result.disposition, DISPOSITIONS.PROSPECTIVE_RENTER);
  });

  test('an empty or link-only message is held, not guessed at', () => {
    assert.equal(triage.classify({ text: '' }).disposition, DISPOSITIONS.UNCLEAR);
    assert.equal(triage.classify({ text: 'https://example.com/thing' }).disposition, DISPOSITIONS.UNCLEAR);
    assert.equal(triage.classify({ text: '' }).needsHuman, true);
  });

  test('complaints and legal language always reach a human', () => {
    const result = triage.classify({ text: 'i think that property discriminated against me' });
    assert.equal(result.needsHuman, true);
    assert.equal(ROUTING[result.disposition].handOffToReplyEngine, false);
  });

  test('states what is still missing so the next question is obvious', () => {
    const result = triage.classify({ text: 'looking for a 2 bed' });
    assert.ok(result.missing.includes('budget'));
    assert.ok(result.missing.includes('move date'));
    assert.equal(result.missing.includes('size'), false, 'size was stated');
  });
});

describe('classifying a whole thread', () => {
  test('a search stated mid-thread outranks a trailing "ok thanks"', () => {
    const result = triage.classifyThread([
      { text: 'hey' },
      { text: 'looking for a 2 bed in uptown, budget 2k, moving sept 1' },
      { text: 'ok thanks' },
    ]);
    assert.equal(result.disposition, DISPOSITIONS.PROSPECTIVE_RENTER);
  });

  test('spam anywhere in a thread makes the thread spam', () => {
    const result = triage.classifyThread([
      { text: 'hey looking for a place' },
      { text: 'also check out my crypto page, make $500 a day' },
    ]);
    assert.equal(result.disposition, DISPOSITIONS.SPAM_OR_BOT);
  });

  test('signals accumulate across the thread', () => {
    const result = triage.classifyThread([
      { text: 'looking for a 2 bed' },
      { text: 'budget is about 1800' },
      { text: 'moving september 1' },
    ]);
    const kinds = result.signals.map((s) => s.kind);
    assert.ok(kinds.includes('stated_size'));
    assert.ok(kinds.includes('stated_budget'));
    assert.ok(kinds.includes('stated_timeline'));
  });

  test('an empty thread does not throw', () => {
    assert.equal(triage.classifyThread([]).disposition, DISPOSITIONS.UNCLEAR);
  });
});

describe('market awareness', () => {
  test('an area outside the configured market is flagged, not silently worked', () => {
    const scoped = createTriage({ market: { name: 'Dallas', areas: ['uptown', 'deep ellum', 'oak lawn'] } });
    const inMarket = scoped.classify({ text: 'looking for a 2 bed in uptown under 2k' });
    const outOfMarket = scoped.classify({ text: 'looking for a 2 bed in seattle under 2k' });

    assert.equal(inMarket.disposition, DISPOSITIONS.PROSPECTIVE_RENTER);
    assert.equal(outOfMarket.disposition, DISPOSITIONS.NOT_SERVICEABLE);
    assert.equal(outOfMarket.needsHuman, true, 'a market miss is a judgement call, not a rejection');
  });
});

describe('signals are extensible', () => {
  test('a new detector can be registered without touching triage', () => {
    const detector = createSignalDetector();
    detector.register({ kind: 'corporate_relocation', description: 'relo', re: /\b(relocation package|company is moving me|relo)\b/ });
    const custom = createTriage({ detector });
    const result = custom.classify({ text: 'my company is moving me to town, need a 2 bed' });
    assert.ok(result.signals.some((s) => s.kind === 'corporate_relocation'));
  });

  test('structured extraction from another module feeds the same signals', () => {
    const withExtractor = createTriage({
      extractSlots: () => ({ budget: { max: 2000 }, beds: 2, moveIn: { iso: '2026-09-01' } }),
    });
    const result = withExtractor.classify({ text: 'anything available' });
    const kinds = result.signals.map((s) => s.kind);
    assert.ok(kinds.includes('stated_budget'));
    assert.ok(result.signals.find((s) => s.kind === 'stated_budget').source === 'extractor');
  });

  test('a throwing extractor does not break classification', () => {
    const broken = createTriage({
      extractSlots: () => {
        throw new Error('boom');
      },
    });
    assert.equal(broken.classify({ text: 'hey' }).disposition, DISPOSITIONS.NEEDS_QUALIFICATION);
  });
});

describe('identifier normalization', () => {
  test('handles are stripped to their canonical form', () => {
    assert.equal(normalizeHandle('@JessicaR'), 'jessicar');
    assert.equal(normalizeHandle('https://www.instagram.com/jessicar/'), 'jessicar');
    assert.equal(normalizeHandle('not a handle!'), null);
  });

  test('phones normalize to E.164 or nothing', () => {
    assert.equal(normalizePhone('(214) 555-0184'), '+12145550184');
    assert.equal(normalizePhone('1-214-555-0184'), '+12145550184');
    assert.equal(normalizePhone('12345'), null, 'a partial number is worse than none');
  });

  test('emails, linkedin urls, and websites normalize predictably', () => {
    assert.equal(normalizeEmail('  Person@Example.COM '), 'person@example.com');
    assert.equal(normalizeEmail('nope'), null);
    assert.equal(normalizeLinkedInUrl('linkedin.com/in/Jane-Doe-123/'), 'https://www.linkedin.com/in/jane-doe-123');
    assert.equal(normalizeWebsite('www.Example.com/'), 'https://example.com');
    assert.equal(normalizeWebsite('not a url'), null);
  });

  test('identifier strength decides what may auto-merge', () => {
    assert.equal(makeIdentifier('phone', '2145550184').strength, 'strong');
    assert.equal(makeIdentifier('instagram_id', '17841400000000001').strength, 'strong');
    assert.equal(makeIdentifier('instagram_handle', 'jessicar').strength, 'weak');
    assert.equal(makeIdentifier('website', 'acme.com').strength, 'weak');
  });
});

describe('identity resolution is conservative', () => {
  test('a shared phone number merges', () => {
    const a = createPerson({ identifiers: [makeIdentifier('phone', '2145550184')] });
    const b = createPerson({ identifiers: [makeIdentifier('phone', '(214) 555-0184')] });
    const result = compareIdentities(a, b);
    assert.equal(result.merge, true);
  });

  test('a shared handle only suggests — handles get reassigned', () => {
    const a = createPerson({ identifiers: [makeIdentifier('instagram_handle', 'jessicar')] });
    const b = createPerson({ identifiers: [makeIdentifier('instagram_handle', '@JessicaR')] });
    const result = compareIdentities(a, b);
    assert.equal(result.merge, false);
    assert.equal(result.suggest, true);
  });

  test('a matching name never merges anyone', () => {
    const a = createPerson({ displayName: 'John Smith' });
    const b = createPerson({ displayName: 'john smith' });
    const result = compareIdentities(a, b);
    assert.equal(result.merge, false);
    assert.equal(result.suggest, true);
  });

  test('unrelated people are left alone', () => {
    const a = createPerson({ identifiers: [makeIdentifier('phone', '2145550184')], displayName: 'A' });
    const b = createPerson({ identifiers: [makeIdentifier('phone', '2145559999')], displayName: 'B' });
    assert.deepEqual(compareIdentities(a, b), { merge: false, suggest: false, reason: 'no shared identifiers' });
  });

  test('merging keeps both sets of identifiers and records the fold', () => {
    const a = createPerson({ identifiers: [makeIdentifier('instagram_handle', 'jess')], displayName: 'Jess' });
    const b = createPerson({ identifiers: [makeIdentifier('phone', '2145550184')] });
    const merged = mergePeople(a, b);
    assert.equal(merged.identifiers.length, 2);
    assert.ok(merged.mergedFrom.includes(b.id));
  });
});

describe('facts on a person', () => {
  test('a newer fact from the same source replaces the older one', () => {
    let person = createPerson({});
    person = addFacts(person, [{ field: 'instagram.followers', value: 100, source: 'instagram-public', observedAt: '2026-01-01' }]);
    person = addFacts(person, [{ field: 'instagram.followers', value: 250, source: 'instagram-public', observedAt: '2026-02-01' }]);
    assert.equal(person.facts.length, 1);
    assert.equal(person.facts[0].value, 250);
  });

  test('two sources disagreeing are both kept', () => {
    let person = createPerson({});
    person = addFacts(person, [
      { field: 'location.stated', value: 'Dallas', source: 'instagram-public', observedAt: '2026-01-01' },
      { field: 'location.stated', value: 'Fort Worth', source: 'linkedin', observedAt: '2026-01-02' },
    ]);
    assert.equal(person.facts.length, 2, 'the disagreement is information, not an error');
  });

  test('adding a known identifier changes nothing', () => {
    const person = createPerson({ identifiers: [makeIdentifier('instagram_handle', 'jess')] });
    const again = addIdentifiers(person, [makeIdentifier('instagram_handle', '@jess')]);
    assert.equal(again.identifiers.length, 1);
  });
});
