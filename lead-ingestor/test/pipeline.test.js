import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { createIngestor, EVENTS, DISPOSITIONS, makeRawEvent } from '../src/index.js';
import { createEnricher } from '../src/enrichment/enricher.js';
import { buildProspectSheet, renderProspectSheet } from '../src/enrichment/prospect-sheet.js';
import { createPerson } from '../src/identity/identity.js';
import { makeIdentifier } from '../src/identity/handles.js';
import { createLinkedInProvider, candidateUrlFrom } from '../src/enrichment/providers/linkedin.js';
import { createWebsiteProvider } from '../src/enrichment/providers/website.js';
import { readArchive, archiveToEvents } from '../src/sources/archive.js';
import { createPacer, parseNotificationDump } from '../src/sources/device-bridge.js';
import { sampleExport, ME } from './fixtures.js';

let counter = 0;
function event(text, { handle = 'jessicar', id, threadId, platformId = '178414000001', source = 'test' } = {}) {
  return makeRawEvent({
    source,
    platformId,
    handle,
    displayName: 'Jessica R',
    id: id ?? `e${++counter}`,
    threadId: threadId ?? `ig:${platformId}`,
    text,
    occurredAt: Date.now(),
  });
}

describe('the ingest pipeline', () => {
  test('turns a message into a person, a lead, and a triage decision', async () => {
    const ingestor = createIngestor();
    const [result] = await ingestor.ingest([event('hey, looking for a 2 bed in uptown under 2k, moving sept 1')]);

    assert.equal(result.triage.disposition, DISPOSITIONS.PROSPECTIVE_RENTER);
    assert.ok(result.person.id.startsWith('p_'));
    assert.equal(result.lead.personId, result.person.id);
    assert.equal(result.lead.state, 'triaged');

    const stats = await ingestor.stats();
    assert.deepEqual({ people: stats.people, leads: stats.leads, events: stats.events }, { people: 1, leads: 1, events: 1 });
  });

  test('the same event arriving twice is ingested once', async () => {
    const ingestor = createIngestor();
    const duplicate = event('hey', { id: 'same-id' });
    await ingestor.ingest([duplicate]);
    const second = await ingestor.ingest([duplicate]);

    assert.deepEqual(second, []);
    assert.equal((await ingestor.stats()).events, 1);
  });

  test('overlapping sources seeing the same DM do not create two leads', async () => {
    const ingestor = createIngestor();
    await ingestor.ingest([event('hey there', { id: 'api-1', source: 'graph-api' })]);
    await ingestor.ingest([event('hey there', { id: 'device-1', source: 'device' })]);

    const stats = await ingestor.stats();
    assert.equal(stats.events, 2, 'both observations are kept');
    assert.equal(stats.leads, 1, 'but they are the same conversation');
    assert.equal(stats.people, 1);
  });

  test('a returning person is recognized across messages', async () => {
    const ingestor = createIngestor();
    await ingestor.ingest([event('hey')]);
    await ingestor.ingest([event('actually im looking for a 1 bed')]);

    const stats = await ingestor.stats();
    assert.equal(stats.people, 1);
    assert.equal(stats.leads, 1);
  });

  test('triage reads the whole thread, not just the last message', async () => {
    const ingestor = createIngestor();
    await ingestor.ingest([event('hey')]);
    await ingestor.ingest([event('looking for a 2 bed in uptown, budget 2k, moving sept 1')]);
    const [last] = await ingestor.ingest([event('ok thanks')]);

    assert.equal(last.triage.disposition, DISPOSITIONS.PROSPECTIVE_RENTER);
  });

  test('a volunteered phone number becomes a strong identifier', async () => {
    const ingestor = createIngestor();
    const [result] = await ingestor.ingest([event('my number is 214-555-0184')]);
    const person = await ingestor.store.getPerson(result.person.id);
    assert.ok(person.identifiers.some((i) => i.kind === 'phone' && i.value === '+12145550184'));
  });

  test('events are emitted for anything downstream to observe', async () => {
    const ingestor = createIngestor();
    const seen = [];
    ingestor.bus.on('*', (_payload, meta) => seen.push(meta.event));
    await ingestor.ingest([event('looking for a 2 bed, budget 1800, moving asap')]);

    assert.ok(seen.includes(EVENTS.EVENT_INGESTED));
    assert.ok(seen.includes(EVENTS.PERSON_CREATED));
    assert.ok(seen.includes(EVENTS.LEAD_OPENED));
    assert.ok(seen.includes(EVENTS.LEAD_TRIAGED));
  });
});

describe('routing', () => {
  test('a real search is handed to the reply engine with a prospect sheet', async () => {
    const handoffs = [];
    const ingestor = createIngestor({ onHandoff: (payload) => handoffs.push(payload) });
    await ingestor.ingest([event('looking for a 2 bed in uptown under 2k, moving september 1')]);

    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].sheet.triage.disposition, DISPOSITIONS.PROSPECTIVE_RENTER);
    assert.ok(handoffs[0].sheet.statedNeeds.length > 0);
    assert.equal(handoffs[0].lead.state, 'handed_off');
  });

  test('spam and vendor pitches are never handed off', async () => {
    const handoffs = [];
    const ingestor = createIngestor({ onHandoff: (p) => handoffs.push(p) });
    await ingestor.ingest([
      event('make $500 a day with bitcoin dm me', { platformId: '1', handle: 'spam1' }),
      event('i can grow your following and get you more leads', { platformId: '2', handle: 'vendor1' }),
    ]);
    assert.equal(handoffs.length, 0);
  });

  test('a lead needing a human is held and announced, not silently dropped', async () => {
    const held = [];
    const ingestor = createIngestor({ onHandoff: () => {} });
    ingestor.bus.on(EVENTS.LEAD_HELD, (p) => held.push(p));
    await ingestor.ingest([event('do you help people buy a house? im pre-approved')]);

    assert.equal(held.length, 1);
    assert.match(held[0].reason, /buy/);
  });

  test('a failing handoff keeps the lead instead of losing it', async () => {
    const held = [];
    const ingestor = createIngestor({
      onHandoff: () => {
        throw new Error('reply engine unreachable');
      },
    });
    ingestor.bus.on(EVENTS.LEAD_HELD, (p) => held.push(p));
    const [result] = await ingestor.ingest([event('looking for a 2 bed in uptown, 2k, sept 1')]);

    assert.equal(result.lead.state, 'triaged', 'not marked as handed off');
    assert.equal(held.length, 1);
    assert.match(held[0].reason, /handoff failed/);
  });

  test('a historical import fires no handoffs when none is wired up', async () => {
    const fixture = sampleExport();
    try {
      const ingestor = createIngestor();
      const events = archiveToEvents(readArchive(fixture.root), { meName: ME });
      const results = await ingestor.ingest(events);

      assert.ok(results.length > 0);
      const dispositions = new Set(results.map((r) => r.triage.disposition));
      assert.ok(dispositions.has(DISPOSITIONS.PROSPECTIVE_RENTER));
      assert.ok(dispositions.has(DISPOSITIONS.SPAM_OR_BOT));
      assert.ok(dispositions.has(DISPOSITIONS.VENDOR_OR_RECRUITER));
      assert.ok(dispositions.has(DISPOSITIONS.NOT_SERVICEABLE));
    } finally {
      fixture.cleanup();
    }
  });
});

describe('industry contacts are separated from customers', () => {
  // The directory's resolver contract, stubbed. No import from module 3 — the
  // point of injecting it is that neither module depends on the other.
  const known = {
    'dana.at.themaple': {
      party: 'industry',
      confidence: 'certain',
      matchedOn: 'instagram',
      contact: { id: 'c_dana', displayName: 'Dana Price' },
      node: { id: 'n_maple', name: 'The Maple' },
      reason: 'Dana Price is on file as property manager at The Maple',
    },
  };
  const identifyParty = (actor) =>
    known[actor.handle] ?? { party: 'unknown', confidence: 'none', reason: 'not a known industry contact' };

  test('a property manager is never triaged as a renter', async () => {
    const handoffs = [];
    const ingestor = createIngestor({ identifyParty, onHandoff: (p) => handoffs.push(p) });

    // Wording that would absolutely qualify as a lead from anyone else.
    const [result] = await ingestor.ingest([
      event('hey! do you have any 2 bedrooms under 2k available for september?', { handle: 'dana.at.themaple' }),
    ]);

    assert.equal(result.triage.disposition, DISPOSITIONS.INDUSTRY_CONTACT);
    assert.equal(handoffs.length, 0, 'never handed to the reply engine');
    assert.match(result.triage.reasons[0], /property manager at The Maple/);
  });

  test('the property they work at is recorded on the lead', async () => {
    const ingestor = createIngestor({ identifyParty });
    const [result] = await ingestor.ingest([event('checking in on that referral', { handle: 'dana.at.themaple' })]);
    assert.equal(result.lead.ext.party.node, 'n_maple');
    assert.equal(result.lead.ext.party.contact, 'c_dana');
  });

  test('an industry message is announced on its own channel', async () => {
    const ingestor = createIngestor({ identifyParty });
    const seen = [];
    ingestor.bus.on(EVENTS.INDUSTRY_MESSAGE, (p) => seen.push(p));
    await ingestor.ingest([event('we have 3 units coming up', { handle: 'dana.at.themaple' })]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].party.confidence, 'certain');
  });

  test('industry contacts are never enriched', async () => {
    let enrichCalls = 0;
    const ingestor = createIngestor({
      identifyParty,
      enrichInline: true,
      enrichmentProviders: [{ name: 'counting', appliesTo: () => true, fetch: async () => { enrichCalls++; return []; } }],
    });
    await ingestor.ingest([event('hey', { handle: 'dana.at.themaple' })]);
    assert.equal(enrichCalls, 0, 'there is no reason to build a profile of a property manager');
  });

  test('an unknown sender is unaffected and still becomes a lead', async () => {
    const handoffs = [];
    const ingestor = createIngestor({ identifyParty, onHandoff: (p) => handoffs.push(p) });
    const [result] = await ingestor.ingest([
      event('looking for a 2 bed in uptown under 2k, moving sept 1', { handle: 'jessicarenter' }),
    ]);
    assert.equal(result.triage.disposition, DISPOSITIONS.PROSPECTIVE_RENTER);
    assert.equal(handoffs.length, 1);
  });

  test('a probable match goes to a person rather than being assumed', async () => {
    const ingestor = createIngestor({
      identifyParty: () => ({
        party: 'industry',
        confidence: 'probable',
        matchedOn: 'domain',
        reason: 'writes from alderres.com, a known management domain',
      }),
    });
    const [result] = await ingestor.ingest([event('looking for a 1 bed', { handle: 'someone.new' })]);
    assert.equal(result.triage.disposition, DISPOSITIONS.INDUSTRY_CONTACT);
    assert.equal(result.triage.needsHuman, true, 'the company being known does not mean this person is staff');
  });

  test('a directory that throws does not stop the inbox', async () => {
    const handoffs = [];
    const ingestor = createIngestor({
      identifyParty: () => { throw new Error('directory unavailable'); },
      onHandoff: (p) => handoffs.push(p),
    });
    const [result] = await ingestor.ingest([event('looking for a 2 bed in uptown, 2k, sept 1')]);
    assert.equal(result.triage.disposition, DISPOSITIONS.PROSPECTIVE_RENTER, 'falls back to treating them as a customer');
    assert.equal(handoffs.length, 1);
  });

  test('one industry message makes the whole thread industry', async () => {
    const ingestor = createIngestor({ identifyParty });
    const thread = 'mixed:1';
    await ingestor.ingest([event('do you have 2 bedrooms?', { handle: 'dana.at.themaple', threadId: thread })]);
    const [second] = await ingestor.ingest([event('thanks!', { handle: 'dana.at.themaple', threadId: thread })]);
    assert.equal(second.triage.disposition, DISPOSITIONS.INDUSTRY_CONTACT);
  });
});

describe('enrichment', () => {
  const provider = (name, facts, opts = {}) => ({
    name,
    appliesTo: opts.appliesTo ?? (() => true),
    fetch: opts.fetch ?? (async () => facts),
    ...opts,
  });

  test('never enriches spam or vendor pitches', async () => {
    const enricher = createEnricher({ providers: [provider('any', [{ field: 'x', value: 1 }])] });
    const result = await enricher.enrich(createPerson({}), { triage: { disposition: DISPOSITIONS.SPAM_OR_BOT } });
    assert.deepEqual(result.facts, []);
    assert.match(result.skipped[0].reason, /not enriched/);
  });

  test('stamps every fact with its provenance', async () => {
    const enricher = createEnricher({ providers: [provider('p1', [{ field: 'instagram.followers', value: 1200 }])] });
    const { facts } = await enricher.enrich(createPerson({}), { triage: { disposition: DISPOSITIONS.PROSPECTIVE_RENTER } });
    assert.equal(facts[0].source, 'p1');
    assert.ok(facts[0].observedAt);
    assert.ok(facts[0].method);
  });

  test('a failing provider does not stop the others', async () => {
    const enricher = createEnricher({
      providers: [
        provider('broken', null, { fetch: async () => { throw new Error('profile is private'); } }),
        provider('working', [{ field: 'ok', value: true }]),
      ],
    });
    const result = await enricher.enrich(createPerson({}), {});
    assert.equal(result.facts.length, 1);
    assert.ok(result.skipped.some((s) => s.provider === 'broken' && /private/.test(s.reason)));
  });

  test('the per-person call budget is enforced', async () => {
    const providers = Array.from({ length: 6 }, (_, i) => provider(`p${i}`, [{ field: `f${i}`, value: i }]));
    const enricher = createEnricher({ providers, maxCallsPerPerson: 2 });
    const result = await enricher.enrich(createPerson({}), {});
    assert.equal(result.ran.length, 2);
    assert.ok(result.skipped.some((s) => /budget/.test(s.reason)));
  });

  test('a cached fact is not re-fetched', async () => {
    let calls = 0;
    const enricher = createEnricher({
      providers: [provider('counting', null, { fetch: async () => { calls++; return [{ field: 'a', value: 1 }]; } })],
    });
    const person = createPerson({});
    await enricher.enrich(person, {});
    const second = await enricher.enrich(person, {});
    assert.equal(calls, 1);
    assert.equal(second.facts.length, 1, 'cached facts still come back');
  });

  test('force bypasses the cache', async () => {
    let calls = 0;
    const enricher = createEnricher({
      providers: [provider('counting', null, { fetch: async () => { calls++; return [{ field: 'a', value: calls }]; } })],
    });
    const person = createPerson({});
    await enricher.enrich(person, {});
    await enricher.enrich(person, { force: true });
    assert.equal(calls, 2);
  });

  test('enriched facts land on the person record', async () => {
    const ingestor = createIngestor({
      enrichInline: true,
      enrichmentProviders: [provider('fake-ig', [{ field: 'instagram.followers', value: 900 }])],
    });
    const [result] = await ingestor.ingest([event('looking for a 2 bed in uptown, 2k, sept 1')]);
    const person = await ingestor.store.getPerson(result.person.id);
    assert.equal(person.facts.find((f) => f.field === 'instagram.followers').value, 900);
  });
});

describe('the linkedin provider resolves rather than scrapes', () => {
  test('finds a profile URL the person published in their bio', async () => {
    let person = createPerson({ identifiers: [makeIdentifier('instagram_handle', 'jessicar')] });
    person.facts = [
      { field: 'instagram.biography', value: 'realtor | linkedin.com/in/jessica-r-123', source: 'instagram-public', observedAt: 'now' },
    ];
    const found = candidateUrlFrom(person);
    assert.equal(found.url, 'https://www.linkedin.com/in/jessica-r-123');
    assert.ok(found.confidence < 1, 'a discovered URL is a candidate, not a confirmation');
  });

  test('an operator-entered URL is treated as confirmed', () => {
    const person = createPerson({ identifiers: [makeIdentifier('linkedin_url', 'linkedin.com/in/jane-doe')] });
    assert.equal(candidateUrlFrom(person).confidence, 1);
  });

  test('says it found nothing rather than inventing a profile', async () => {
    const provider = createLinkedInProvider({});
    const facts = await provider.fetch(createPerson({ displayName: 'Common Name' }), {});
    assert.equal(facts[0].field, 'linkedin.lookup');
    assert.equal(facts[0].value, 'no candidate found');
  });

  test('a licensed vendor can be injected without touching the provider', async () => {
    const provider = createLinkedInProvider({
      vendorLookup: async () => ({ profile_url: 'https://www.linkedin.com/in/x', job_title: 'Nurse', job_company_name: 'Baylor' }),
    });
    const person = createPerson({ identifiers: [makeIdentifier('email', 'a@b.com')], displayName: 'A B' });
    const facts = await provider.fetch(person, {});
    assert.ok(facts.some((f) => f.field === 'employer.title' && f.value === 'Nurse'));
    assert.ok(facts.every((f) => f.method !== 'public_page'), 'vendor data must not look like a page read');
  });
});

describe('the website provider is polite', () => {
  test('honors a robots.txt disallow instead of fetching anyway', async () => {
    const requested = [];
    const provider = createWebsiteProvider({
      fetchImpl: async (url) => {
        requested.push(String(url));
        if (String(url).endsWith('/robots.txt')) {
          return { ok: true, headers: { get: () => 'text/plain' }, text: async () => 'User-agent: *\nDisallow: /' };
        }
        return { ok: true, headers: { get: () => 'text/html' }, text: async () => '<title>Should not be read</title>' };
      },
    });
    const person = createPerson({ identifiers: [makeIdentifier('website', 'example.com')] });
    const facts = await provider.fetch(person, {});
    assert.equal(requested.filter((u) => !u.endsWith('/robots.txt')).length, 0);
    assert.equal(facts[0].value, false);
  });

  test('extracts page facts and any linkedin link it finds', async () => {
    const provider = createWebsiteProvider({
      fetchImpl: async (url) => {
        if (String(url).endsWith('/robots.txt')) {
          return { ok: true, headers: { get: () => 'text/plain' }, text: async () => 'User-agent: *\nAllow: /' };
        }
        return {
          ok: true,
          headers: { get: () => 'text/html' },
          text: async () =>
            '<title>Jessica R — Nurse</title><meta name="description" content="RN in Dallas">' +
            '<a href="https://www.linkedin.com/in/jessica-r-123">LinkedIn</a>',
        };
      },
    });
    const person = createPerson({ identifiers: [makeIdentifier('website', 'jessicar.com')] });
    const facts = await provider.fetch(person, {});
    assert.ok(facts.some((f) => f.field === 'website.title' && /Nurse/.test(String(f.value))));
    assert.ok(facts.some((f) => f.field === 'linkedin.url'));
  });
});

describe('the prospect sheet', () => {
  function sheetFixture() {
    const person = createPerson({
      identifiers: [makeIdentifier('instagram_handle', 'jessicar'), makeIdentifier('phone', '2145550184')],
      displayName: 'Jessica R',
    });
    person.facts = [
      { field: 'instagram.followers', value: 1200, source: 'instagram-public', method: 'api', observedAt: '2026-03-01', url: 'https://instagram.com/jessicar' },
      { field: 'location.stated', value: 'Dallas', source: 'instagram-public', method: 'api', observedAt: '2026-03-01' },
      { field: 'location.stated', value: 'Fort Worth', source: 'linkedin', method: 'vendor', observedAt: '2026-03-02' },
    ];
    const lead = {
      id: 'l1',
      personId: person.id,
      triage: {
        disposition: DISPOSITIONS.PROSPECTIVE_RENTER,
        reasons: ['stated they are looking for a place'],
        signals: [{ kind: 'stated_budget', evidence: 'under 2k', source: 'text' }],
        missing: ['move date'],
        confidence: 0.85,
        needsHuman: false,
      },
      firstSeenAt: '2026-03-01',
      lastSeenAt: '2026-03-02',
      eventIds: [],
      state: 'triaged',
      ext: {},
    };
    return { person, lead };
  }

  test('carries no score, rank, or tier anywhere in it', () => {
    const { person, lead } = sheetFixture();
    const sheet = buildProspectSheet({ person, lead, events: [] });
    const json = JSON.stringify(sheet).toLowerCase();
    for (const banned of ['"score"', '"rank"', '"tier"', '"grade"', '"rating"', '"priority"']) {
      assert.equal(json.includes(banned), false, `the sheet must not contain ${banned}`);
    }
  });

  test('every profile line names where it came from', () => {
    const { person, lead } = sheetFixture();
    const sheet = buildProspectSheet({ person, lead, events: [] });
    for (const fact of sheet.profile) {
      assert.ok(fact.source, 'a fact without a source is a rumor');
      assert.ok(fact.method);
    }
  });

  test('surfaces disagreements between sources instead of picking one', () => {
    const { person, lead } = sheetFixture();
    const sheet = buildProspectSheet({ person, lead, events: [] });
    const conflict = sheet.conflicts.find((c) => c.field === 'location.stated');
    assert.ok(conflict);
    assert.equal(conflict.values.length, 2);
  });

  test('states what is unknown so the next message has a purpose', () => {
    const { person, lead } = sheetFixture();
    const sheet = buildProspectSheet({ person, lead, events: [] });
    assert.ok(sheet.gaps.criteria.includes('move date'));
    assert.ok(sheet.gaps.identity.includes('no email'));
  });

  test('renders to something a human can read at a glance', () => {
    const { person, lead } = sheetFixture();
    const text = renderProspectSheet(buildProspectSheet({ person, lead, events: [] }));
    assert.match(text, /Jessica R/);
    assert.match(text, /prospective_renter/);
    assert.match(text, /not known/);
    assert.doesNotMatch(text, /score/i);
  });
});

describe('the device rig paces itself', () => {
  test('sleeps through the night rather than polling at 4am', () => {
    const night = createPacer({ quietStart: 23, quietEnd: 7, now: () => Date.parse('2026-03-01T04:00:00') });
    assert.equal(night.isQuietHours(), true);
    assert.ok(night.nextDelay(() => 0.5) > 60 * 60 * 1000, 'it waits for morning, not a few minutes');
  });

  test('never polls on a fixed interval, because that is the tell', () => {
    const day = createPacer({ quietStart: 23, quietEnd: 7, now: () => Date.parse('2026-03-01T14:00:00') });
    const delays = new Set(Array.from({ length: 20 }, (_, i) => day.nextDelay(() => i / 20)));
    assert.ok(delays.size > 10, 'delays must vary');
    assert.ok(Math.min(...delays) >= 60_000, 'and never get aggressive');
  });

  test('reads instagram messages out of a notification dump', () => {
    const dump = `
      NotificationRecord(pkg=com.instagram.android when=1772000000000
        android.title=String (jessicar)
        android.text=String (hey! looking for a 2 bed in uptown))
      NotificationRecord(pkg=com.instagram.android when=1772000001000
        android.title=String (someone)
        android.text=String (liked your photo))
      NotificationRecord(pkg=com.other.app when=1772000002000
        android.title=String (ignore)
        android.text=String (not instagram))
    `;
    const messages = parseNotificationDump(dump);
    assert.equal(messages.length, 1, 'likes are not leads, and other apps are not ours');
    assert.equal(messages[0].handle, 'jessicar');
    assert.match(messages[0].text, /2 bed/);
  });
});
