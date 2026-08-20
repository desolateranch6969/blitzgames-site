import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDirectory } from '../src/index.js';
import { freshnessOf, verificationNeeded, DEFAULT_FRESHNESS } from '../src/contacts/cards.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

/**
 * A company shaped the way a large third-party manager actually is: corporate at
 * the top, a regional covering a handful of properties, site teams beneath.
 */
function seedPortfolio({ now = () => NOW } = {}) {
  const directory = createDirectory({ now });
  const { tree, roster } = directory;

  const corp = tree.insert(node(tree, 'management_company', 'Alder Residential'));
  const region = tree.insert(node(tree, 'region', 'North Texas', corp.id));
  const maple = tree.insert(node(tree, 'property', 'The Maple', region.id));
  const cedar = tree.insert(node(tree, 'property', 'Cedar Row', region.id));
  const lark = tree.insert(node(tree, 'property', 'Lark House', region.id));

  const add = (name, title, nodeId, verifiedAt) => {
    const contact = roster.addContact(
      makeContact(directory, { displayName: name, rawTitle: title, verifiedAt }),
    );
    roster.assign(contact.id, nodeId, { keepOthers: true });
    return contact;
  };

  const regional = add('Nia Patel', 'Regional Manager', region.id, ago(200));
  const exec = add('Darren Vance', 'VP of Operations', corp.id, ago(400));
  const pm = add('Dana Price', 'Property Manager', maple.id, ago(200));
  const office = add('The Maple leasing office', 'Leasing Office', maple.id, ago(200));

  return { directory, tree, roster, corp, region, maple, cedar, lark, regional, exec, pm, office };
}

function node(tree, kind, name, parentId) {
  const { createNode } = tree.__test ?? {};
  return createNodeShim(kind, name, parentId);
}

// The tree's createNode is exported from the module; import it lazily to keep
// this fixture readable.
import { createNode as makeNode } from '../src/tree/tree.js';
import { createContact } from '../src/contacts/contacts.js';
function createNodeShim(kind, name, parentId) {
  return makeNode({ kind, name, parentId });
}
function makeContact(_directory, init) {
  return createContact(init);
}

describe('the two-card model', () => {
  test('the local card carries the site team and is the primary view', () => {
    const { directory, maple } = seedPortfolio();
    const { local } = directory.cards(maple.id);

    assert.equal(local.scope.name, 'The Maple');
    assert.equal(local.office.name, 'The Maple leasing office');
    assert.equal(local.primary.name, 'Dana Price');
    assert.equal(local.volatile, true);
  });

  test('the master card resolves to the regional, not to corporate', () => {
    const { directory, maple } = seedPortfolio();
    const { master } = directory.cards(maple.id);

    assert.equal(master.scope.name, 'North Texas', 'the nearest ancestor holding contacts names the card');
    assert.equal(master.people[0].name, 'Nia Patel', 'and the regional leads it');
    assert.equal(master.durable, true);
  });

  test('corporate sits behind the regional rather than above them', () => {
    const { directory, maple } = seedPortfolio();
    const { master } = directory.cards(maple.id);

    assert.deepEqual(
      master.people.map((p) => p.name),
      ['Nia Patel', 'Darren Vance'],
      'the VP outranks the regional but is useless about one property',
    );
    assert.equal(master.people[0].fromNode.name, 'North Texas');
    assert.equal(master.people[1].fromNode.name, 'Alder Residential');
  });

  test('an import option in the wrong argument fails loudly instead of writing', () => {
    const directory = createDirectory();
    assert.throws(
      () => directory.importCrm({ text: 'Community\nThe Maple\n', dryRun: true }),
      /belong in the second argument/,
    );
  });

  test('the master card names how many sister properties share it', () => {
    const { directory, maple } = seedPortfolio();
    assert.equal(directory.cards(maple.id).master.sharedWith, 2, 'maintained once, inherited by Cedar Row and Lark House');
  });

  test('a property with nothing above it has no master card', () => {
    const directory = createDirectory({ now: () => NOW });
    const independent = directory.tree.insert(makeNode({ kind: 'property', name: 'Owner-operated Flats' }));
    const cards = directory.cards(independent.id);

    assert.equal(cards.master, null);
    assert.deepEqual(cards.local.people, []);
  });

  test('a property with no site team still inherits a usable master card', () => {
    const { directory, lark } = seedPortfolio();
    const cards = directory.cards(lark.id);

    assert.deepEqual(cards.local.people, [], 'nobody on site');
    assert.equal(cards.master.people[0].name, 'Nia Patel', 'but there is still someone to call');
  });
});

describe('the two cards run on different clocks', () => {
  test('the same age reads as stale locally and fine at the master level', () => {
    const { directory, maple } = seedPortfolio();
    const { local, master } = directory.cards(maple.id);

    assert.equal(local.ageDays, 200);
    assert.equal(local.state, 'stale', 'a 200-day-old site roster is probably wrong');
    assert.equal(master.state, 'aging', 'a 200-day-old regional is probably still right');
  });

  test('the thresholds are the whole point and are configurable', () => {
    assert.equal(freshnessOf(ago(30), 'volatile', { now: NOW }).state, 'fresh');
    assert.equal(freshnessOf(ago(120), 'volatile', { now: NOW }).state, 'aging');
    assert.equal(freshnessOf(ago(400), 'volatile', { now: NOW }).state, 'stale');

    assert.equal(freshnessOf(ago(120), 'durable', { now: NOW }).state, 'fresh');
    assert.equal(freshnessOf(ago(400), 'durable', { now: NOW }).state, 'aging');
    assert.equal(freshnessOf(ago(900), 'durable', { now: NOW }).state, 'stale');
  });

  test('never confirmed is its own state, not "stale"', () => {
    assert.deepEqual(freshnessOf(null, 'volatile', { now: NOW }), {
      state: 'unverified',
      ageDays: null,
      verifiedAt: null,
    });
  });
});

describe('a dead local card is recoverable through the master card', () => {
  test('a stale property names the durable contact to call', () => {
    const { directory, maple } = seedPortfolio();
    const need = verificationNeeded(directory.cards(maple.id));

    assert.match(need.reasons[0], /not confirmed in 200 days/);
    assert.equal(need.recoverable, true);
    assert.equal(need.routeBack.via.name, 'Nia Patel');
    assert.match(need.routeBack.note, /who is on site now/);
  });

  test('a property with no master card is flagged as unrecoverable', () => {
    const directory = createDirectory({ now: () => NOW });
    const orphan = directory.tree.insert(makeNode({ kind: 'property', name: 'Nobody Knows' }));
    const need = verificationNeeded(directory.cards(orphan.id));

    assert.equal(need.recoverable, false, 'this is the one that actually needs a human');
    assert.equal(need.routeBack, null);
  });

  test('the work queue puts recoverable properties first', () => {
    const { directory } = seedPortfolio();
    directory.tree.insert(makeNode({ kind: 'property', name: 'Nobody Knows' }));
    const queue = directory.needsVerification();

    assert.ok(queue.length >= 2);
    assert.equal(queue[0].recoverable, true);
    assert.equal(queue.at(-1).recoverable, false);
  });

  test('a healthy property is not in the queue at all', () => {
    const { directory, maple, pm, office } = seedPortfolio();
    directory.roster.recordVerification(pm.id, ago(5));
    directory.roster.recordVerification(office.id, ago(5));

    assert.equal(verificationNeeded(directory.cards(maple.id)), null);
  });
});

describe('verification happens automatically, from traffic', () => {
  test('an inbound message from a known contact refreshes their card', () => {
    const { directory, maple, pm } = seedPortfolio();
    pm.channels.push({ kind: 'instagram', value: 'dana.at.themaple' });
    directory.party.rebuild();

    assert.equal(directory.cards(maple.id).local.state, 'stale');

    const result = directory.observe({ kind: 'inbound_message', handle: '@dana.at.themaple', at: ago(1) });

    assert.equal(result.action, 'verified');
    assert.equal(directory.cards(maple.id).local.state, 'fresh', 'she wrote to us, so she is there');
  });

  test('the party check itself verifies, so the ingestor needs no extra wiring', () => {
    const { directory, maple, pm } = seedPortfolio();
    pm.channels.push({ kind: 'instagram', value: 'dana.at.themaple' });

    const resolve = directory.partyResolver();
    const result = resolve({ handle: 'dana.at.themaple' });

    assert.equal(result.party, 'industry');
    assert.notEqual(directory.cards(maple.id).local.state, 'stale', 'identifying her also refreshed her');
  });

  test('opting out of that keeps identification read-only', () => {
    const { directory, maple, pm } = seedPortfolio();
    pm.channels.push({ kind: 'instagram', value: 'dana.at.themaple' });

    const resolve = directory.partyResolver({ verify: false });
    resolve({ handle: 'dana.at.themaple' });

    assert.equal(directory.cards(maple.id).local.state, 'stale');
  });

  test('a bounce flags the contact without declaring them gone', () => {
    const { directory, pm, roster } = seedPortfolio();
    const result = directory.observe({ kind: 'delivery_failed', email: 'x@y.com', reason: 'mailbox not found' });
    assert.equal(result, null, 'an unknown address is nobody');

    pm.channels.push({ kind: 'email', value: 'dana@alderres.com' });
    directory.party.rebuild();

    const flagged = directory.observe({ kind: 'bounced', email: 'dana@alderres.com', reason: 'mailbox not found' });
    assert.equal(flagged.action, 'flagged_unreachable');
    assert.equal(roster.getContact(pm.id).status, 'unknown', 'flagged, not departed — a bounce is not proof');
    assert.match(roster.getContact(pm.id).notes, /mailbox not found/);
  });

  test('an unreachable contact puts the property back in the queue', () => {
    const { directory, maple, pm } = seedPortfolio();
    directory.roster.recordVerification(pm.id, ago(1));
    pm.channels.push({ kind: 'email', value: 'dana@alderres.com' });
    directory.party.rebuild();

    directory.observe({ kind: 'bounced', email: 'dana@alderres.com' });
    const need = verificationNeeded(directory.cards(maple.id));
    assert.match(need.reasons.join(' '), /stopped responding/);
  });

  test('an unknown sender changes nothing', () => {
    const { directory } = seedPortfolio();
    assert.equal(directory.observe({ kind: 'inbound_message', handle: '@some.renter' }), null);
  });
});

describe('an import is itself a verification', () => {
  const EXPORT = [
    'Community,First Name,Last Name,Title,Email',
    'The Maple,Dana,Price,Property Manager,dana@alderres.com',
    'The Maple,Kim,Ruiz,Leasing Consultant,kim@alderres.com',
  ].join('\n');

  test('imported contacts are fresh as of the export, with nobody clicking anything', () => {
    const directory = createDirectory();
    directory.importCrm({ text: EXPORT });
    const maple = directory.search('maple')[0];

    assert.equal(directory.cards(maple.id).local.state, 'fresh');
  });

  test('a CRM last-contacted column is trusted over the import date', () => {
    const directory = createDirectory({ now: () => NOW });
    directory.importCrm({
      text: `Community,First Name,Last Name,Title,Email,Last Contacted\nThe Maple,Dana,Price,Property Manager,dana@alderres.com,${ago(300).slice(0, 10)}\n`,
    });
    const maple = directory.search('maple')[0];
    const { local } = directory.cards(maple.id);

    assert.equal(local.state, 'stale', 'the CRM says nobody has touched her in 300 days');
    assert.ok(local.ageDays >= 299);
  });

  test('a re-import refreshes everyone still in the file', () => {
    const directory = createDirectory();
    directory.importCrm({ text: EXPORT });
    const maple = directory.search('maple')[0];
    const dana = directory.roster.allContacts().find((c) => c.displayName === 'Dana Price');

    directory.roster.flagUnreachable(dana.id, 'no answer');
    assert.equal(directory.roster.getContact(dana.id).status, 'unknown');

    directory.importCrm({ text: EXPORT });
    assert.equal(directory.roster.getContact(dana.id).status, 'active', 'still in the export means still there');
  });
});

describe('reconciling departures from a full export', () => {
  const BEFORE = [
    'Community,First Name,Last Name,Title,Email',
    'The Maple,Dana,Price,Property Manager,dana@alderres.com',
    'The Maple,Kim,Ruiz,Leasing Consultant,kim@alderres.com',
  ].join('\n');

  // Kim is gone. Nobody told us; she is simply not in the new file.
  const AFTER = [
    'Community,First Name,Last Name,Title,Email',
    'The Maple,Dana,Price,Property Manager,dana@alderres.com',
    'The Maple,Alex,Reed,Leasing Consultant,alex@alderres.com',
  ].join('\n');

  test('absence from a fresh full export marks someone departed', () => {
    const directory = createDirectory();
    directory.importCrm({ text: BEFORE });
    const report = directory.importCrm({ text: AFTER }, { reconcile: true });

    assert.deepEqual(report.departed.map((d) => d.name), ['Kim Ruiz']);

    const maple = directory.search('maple')[0];
    const names = directory.contactsAt(maple.id).map((c) => c.name);
    assert.ok(names.includes('Alex Reed'));
    assert.ok(!names.includes('Kim Ruiz'));
  });

  test('but she is still there in the history', () => {
    const directory = createDirectory();
    directory.importCrm({ text: BEFORE }, { source: { at: ago(365) } });
    directory.importCrm({ text: AFTER }, { reconcile: true, source: { at: ago(1) } });

    const maple = directory.search('maple')[0];
    const past = directory.roster.at(maple.id, { asOf: ago(180) }).map((c) => c.displayName);
    assert.ok(past.includes('Kim Ruiz'), 'departures never erase who was there');
    assert.ok(!directory.contactsAt(maple.id).some((c) => c.name === 'Kim Ruiz'), 'but she is not current');
  });

  test('an old export does not pretend to be fresh', () => {
    const directory = createDirectory({ now: () => NOW });
    directory.importCrm({ text: BEFORE }, { source: { at: ago(300) } });

    const maple = directory.search('maple')[0];
    const { local } = directory.cards(maple.id);
    assert.equal(local.state, 'stale', 'a 300-day-old dump is 300-day-old data');
    assert.equal(local.ageDays, 300);
  });

  test('reconciliation is opt-in, because a partial export would gut the directory', () => {
    const directory = createDirectory();
    directory.importCrm({ text: BEFORE });
    const report = directory.importCrm({ text: AFTER });

    assert.deepEqual(report.departed, [], 'without --reconcile, absence means nothing');
    assert.equal(directory.contactsAt(directory.search('maple')[0].id).length, 3);
  });

  test('it only touches properties the file actually covered', () => {
    const directory = createDirectory();
    directory.importCrm({ text: `${BEFORE}\nCedar Row,Sam,Tran,Property Manager,sam@alderres.com` });
    directory.importCrm({ text: AFTER }, { reconcile: true });

    const cedar = directory.search('cedar')[0];
    assert.equal(directory.contactsAt(cedar.id).length, 1, 'Cedar Row was not in the second file, so it was left alone');
  });

  test('a dry run never departs anybody', () => {
    const directory = createDirectory();
    directory.importCrm({ text: BEFORE });
    const report = directory.importCrm({ text: AFTER }, { reconcile: true, dryRun: true });

    assert.deepEqual(report.departed, []);
    assert.equal(directory.contactsAt(directory.search('maple')[0].id).length, 2);
  });
});
