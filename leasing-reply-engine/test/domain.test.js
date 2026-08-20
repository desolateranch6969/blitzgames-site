import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractSlots, extractBudget, extractSize, extractMoveIn, extractAreas, extractPets, extractScreening, extractContact, extractTourAvailability, mergeSlots } from '../src/domain/slots.js';
import { createClassifier } from '../src/domain/intents.js';
import { createConversation, nextMissingSlot, isQualified, hasSlot, incomeCheck, recordAsk, summarizeLead } from '../src/domain/conversation.js';
import { createMarket } from '../src/domain/market.js';
import { normalize } from '../src/domain/normalize.js';

describe('normalize', () => {
  test('expands DM shorthand and keeps money intact', () => {
    const n = normalize('Hey! im lookin for a 2/2, budget ~$1,800 🔥');
    assert.match(n.clean, /i am looking/);
    assert.match(n.clean, /\$1800/);
    assert.deepEqual(n.emoji, ['🔥']);
  });

  test('detects questions without a question mark', () => {
    assert.equal(normalize('do you charge a fee').hasQuestion, true);
    assert.equal(normalize('im looking for a 2 bed').hasQuestion, false);
  });
});

describe('budget extraction', () => {
  const cases = [
    ['under 2k', { max: 2000 }],
    ['budget like 1800', { max: 1800 }],
    ['1200-1500', { min: 1200, max: 1500 }],
    ['between 1300 and 1600', { min: 1300, max: 1600 }],
    ['no more than $1,750', { max: 1750 }],
    ['around 1.5k', { max: 1500 }],
    ['$2000/mo', { max: 2000 }],
    ['1800 or less', { max: 1800 }],
  ];
  for (const [input, expected] of cases) {
    test(input, () => {
      const got = extractBudget(input);
      assert.equal(got?.max, expected.max);
      if (expected.min) assert.equal(got?.min, expected.min);
    });
  }

  test('ignores numbers that cannot be rent', () => {
    assert.equal(extractBudget('call me at 2145550184'), null);
    assert.equal(extractBudget('i moved here in 1998'), null);
  });
});

describe('size extraction', () => {
  test('parses bed/bath shorthand', () => {
    assert.deepEqual(extractSize('2/2'), { beds: 2, baths: 2 });
    assert.deepEqual(extractSize('1 bedroom 1.5 bath'), { beds: 1, baths: 1.5 });
    assert.equal(extractSize('looking for a studio').beds, 0);
    assert.equal(extractSize('3br').beds, 3);
  });
});

describe('move-in extraction', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');

  test('asap resolves to today', () => {
    assert.equal(extractMoveIn('need something asap', now).iso, '2026-08-20');
  });

  test('named month rolls forward when already past', () => {
    assert.equal(extractMoveIn('moving march 1', now).iso, '2027-03-01');
    assert.equal(extractMoveIn('september 1st', now).iso, '2026-09-01');
  });

  test('flexible timing is captured as flexible', () => {
    const result = extractMoveIn('im flexible on the move date', now);
    assert.equal(result.flexible, true);
  });
});

describe('area extraction', () => {
  test('stops at leasing vocabulary', () => {
    assert.deepEqual(extractAreas('a 2/2 in uptown under 2k'), ['uptown']);
  });

  test('does not invent areas from ordinary phrases', () => {
    assert.deepEqual(extractAreas('flexible on move in date'), []);
    assert.deepEqual(extractAreas('call me in the morning'), []);
  });

  test('uses a market file when one is configured', () => {
    const market = createMarket({ name: 'test', areas: [{ name: 'Deep Ellum', aliases: ['deep ellum', 'ellum'] }] });
    assert.deepEqual(extractAreas('anything in ellum?', market), ['Deep Ellum']);
  });

  test('picks up zip codes', () => {
    assert.deepEqual(extractAreas('near 75204 or 75206'), ['75204', '75206']);
  });
});

describe('screening and pets', () => {
  test('captures rental history that changes the property list', () => {
    assert.deepEqual(extractScreening('i have a broken lease from 2023'), { brokenLease: true });
    assert.deepEqual(extractScreening('no evictions ever'), { eviction: false });
    assert.equal(extractScreening('my credit is bad').poorCredit, true);
  });

  test('an assistance animal is never recorded as a pet', () => {
    assert.equal(extractPets('i have an ESA dog').kind, 'assistance_animal');
  });

  test('distinguishes disclosing a pet from asking about policy', () => {
    assert.equal(extractPets('are they pet friendly?'), null);
    assert.deepEqual(extractPets('i have 2 cats'), { has: true, kind: 'cat', count: 2 });
    assert.deepEqual(extractPets('no pets'), { has: false });
  });

  test('captures dog weight, which decides breed and weight limits', () => {
    assert.equal(extractPets('i have a 50 lb dog').weightLb, 50);
  });
});

describe('contact and tour availability', () => {
  test('parses phone and email without confusing them with rent', () => {
    const contact = extractContact('call me 214-555-0184 or me@example.com');
    assert.equal(contact.phone, '2145550184');
    assert.equal(contact.email, 'me@example.com');
    assert.equal(contact.preferred, 'phone');
  });

  test('captures when a lead can tour', () => {
    assert.equal(extractTourAvailability('saturday works'), 'saturday');
    assert.equal(extractTourAvailability('im free weekdays after 5'), 'weekdays after 5');
  });
});

describe('slot merging', () => {
  test('later facts win and silence never erases', () => {
    const first = extractSlots('2 bed under 2k in uptown');
    const { slots } = mergeSlots(first, extractSlots('actually make it 2500'));
    assert.equal(slots.beds, 2, 'bed count survives a message that did not mention it');
    assert.equal(slots.budget.max, 2500, 'the newer budget wins');
  });

  test('reports which slots changed', () => {
    const { changed } = mergeSlots({}, extractSlots('moving asap'));
    assert.deepEqual(changed, ['moveIn']);
  });
});

describe('classification', () => {
  const classifier = createClassifier();
  const withHistory = { conversation: { turns: [{ role: 'agent', text: 'when are you moving?', at: 0 }] } };

  const cases = [
    ['do you charge anything?', 'ask.fee'],
    ['how much do you charge', 'ask.fee'],
    ['can i tour saturday', 'ask.tour'],
    ['what credit score do they need', 'ask.screening'],
    ['any move in specials', 'ask.specials'],
    ['stop messaging me', 'optout'],
    ['is this a bot', 'human.request'],
    ['2/2 under 1800 in uptown', 'provide.criteria'],
    ['can you send me some options', 'ask.listings'],
    ['want to grow your following? dm me', 'spam'],
  ];
  for (const [text, expected] of cases) {
    test(`"${text}" -> ${expected}`, () => {
      assert.equal(classifier.classify(text, withHistory).primary, expected);
    });
  }

  test('one message can carry several intents', () => {
    const result = classifier.classify('hey do you charge? looking for a 2 bed in uptown under 2k', withHistory);
    assert.ok(result.all.includes('ask.fee'));
    assert.ok(result.all.includes('provide.criteria'));
  });

  test('compliance outranks everything else in the message', () => {
    const result = classifier.classify('is that a safe area? also whats your fee', withHistory);
    assert.equal(result.primary, 'compliance.steering');
  });

  test('a bare yes means nothing before we have asked anything', () => {
    assert.equal(classifier.classify('yes', { conversation: { turns: [] } }).primary, 'unknown');
    assert.equal(classifier.classify('yes', withHistory).primary, 'affirm');
  });

  test('new intents can be registered without touching the engine', () => {
    const custom = createClassifier();
    custom.register({ id: 'ask.parking', description: 'parking', patterns: [/\bparking\b/], priority: 5 });
    assert.equal(custom.classify('is parking included?', withHistory).primary, 'ask.parking');
  });
});

describe('conversation state', () => {
  test('asks for the highest-value missing fact first', () => {
    const convo = createConversation({ threadId: 't', channel: 'test' });
    assert.equal(nextMissingSlot(convo), 'moveIn');
    convo.slots.moveIn = { iso: '2026-09-01' };
    assert.equal(nextMissingSlot(convo), 'areas');
  });

  test('does not re-ask a slot immediately, but retries a required one later', () => {
    const convo = createConversation({ threadId: 't', channel: 'test' });
    recordAsk(convo, 'moveIn');
    assert.notEqual(nextMissingSlot(convo), 'moveIn');

    convo.turns.push(...Array.from({ length: 5 }, () => ({ role: 'lead', text: 'x', at: Date.now() })));
    assert.equal(nextMissingSlot(convo), 'moveIn', 'a required field gets one more try');

    recordAsk(convo, 'moveIn');
    convo.turns.push(...Array.from({ length: 5 }, () => ({ role: 'lead', text: 'x', at: Date.now() })));
    assert.notEqual(nextMissingSlot(convo), 'moveIn', 'but never a third time');
  });

  test('never asks a non-required slot twice', () => {
    const convo = createConversation({ threadId: 't', channel: 'test' });
    convo.slots = { moveIn: { iso: '2026-09-01' }, areas: ['uptown'], beds: 2, budget: { max: 2000 } };
    recordAsk(convo, 'pets');
    convo.turns.push(...Array.from({ length: 10 }, () => ({ role: 'lead', text: 'x', at: Date.now() })));
    assert.notEqual(nextMissingSlot(convo), 'pets');
  });

  test('qualification needs timing, area, size, and budget', () => {
    const convo = createConversation({ threadId: 't', channel: 'test' });
    convo.slots = { moveIn: { iso: '2026-09-01' }, areas: ['uptown'], beds: 2 };
    assert.equal(isQualified(convo).ok, false);
    assert.deepEqual(isQualified(convo).missing, ['budget']);
    convo.slots.budget = { max: 2000 };
    assert.equal(isQualified(convo).ok, true);
  });

  test('income check reports the arithmetic without judging approval', () => {
    const convo = createConversation({ threadId: 't', channel: 'test' });
    convo.slots = { budget: { max: 2000 }, income: { monthlyGross: 5000 } };
    const check = incomeCheck(convo, 3);
    assert.equal(check.required, 6000);
    assert.equal(check.meets, false);
  });

  test('hasSlot treats empty objects and arrays as unset', () => {
    assert.equal(hasSlot({ areas: [] }, 'areas'), false);
    assert.equal(hasSlot({ budget: {} }, 'budget'), false);
    assert.equal(hasSlot({ beds: 0 }, 'beds'), true, 'studio is a real answer');
  });

  test('lead summary is stable for downstream modules', () => {
    const convo = createConversation({ threadId: 't', channel: 'instagram', contact: { id: 'u', name: 'Sam' } });
    convo.slots = { budget: { max: 2000 }, beds: 2, areas: ['uptown'], screening: { brokenLease: true } };
    const summary = summarizeLead(convo);
    assert.equal(summary.budget, 'up to $2000');
    assert.deepEqual(summary.screeningRisks, ['broken_lease']);
    assert.equal(summary.name, 'Sam');
  });
});
