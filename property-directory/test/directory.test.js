import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDirectory } from '../src/index.js';
import { createTree, createNode, naturalKey } from '../src/tree/tree.js';
import { createRoster, createContact, normalizeChannelValue } from '../src/contacts/contacts.js';
import { normalizeTitle, frontDesk, byAuthority, isOffice } from '../src/contacts/titles.js';
import { parseCsv, sniffDelimiter, toCsv } from '../src/import/csv.js';
import { detectMapping } from '../src/import/importer.js';
import { acceptDiscovered } from '../src/sources/source.js';

// ── the hierarchy ───────────────────────────────────────────────────────────

describe('org tree', () => {
  function seed() {
    const tree = createTree();
    const company = tree.insert(createNode({ kind: 'management_company', name: 'Alder Residential' }));
    const region = tree.insert(createNode({ kind: 'region', name: 'North Texas', parentId: company.id }));
    const property = tree.insert(createNode({ kind: 'property', name: 'The Maple', parentId: region.id }));
    return { tree, company, region, property };
  }

  test('materializes a path so subtree queries are a filter, not a walk', () => {
    const { tree, company, region, property } = seed();
    assert.deepEqual(property.path, [company.id, region.id]);
    assert.equal(property.depth, 2);
    assert.equal(tree.descendants(company.id).length, 2);
    assert.deepEqual(tree.ancestors(property.id).map((a) => a.name), ['Alder Residential', 'North Texas']);
  });

  test('rejects a parent that does not exist yet', () => {
    const tree = createTree();
    assert.throws(() => tree.insert(createNode({ name: 'Orphan', parentId: 'nope' })), /does not exist/);
  });

  test('refuses a move that would create a cycle', () => {
    const { tree, company, property } = seed();
    assert.throws(() => tree.move(company.id, property.id), /cycle/);
    assert.throws(() => tree.move(company.id, company.id), /its own parent/);
  });

  test('moving a property to a new company rewrites the whole subtree', () => {
    const { tree, property, company } = seed();
    const building = tree.insert(createNode({ kind: 'building', name: 'Building A', parentId: property.id }));
    const newCompany = tree.insert(createNode({ kind: 'management_company', name: 'Cedar Group' }));

    tree.move(property.id, newCompany.id);

    assert.deepEqual(tree.get(property.id).path, [newCompany.id]);
    assert.deepEqual(tree.get(building.id).path, [newCompany.id, property.id], 'children follow');
    assert.equal(tree.get(building.id).depth, 2);
    assert.equal(tree.descendants(company.id).length, 1, 'the old company keeps only its region');
  });

  test('a property with no parent is legitimate', () => {
    const tree = createTree();
    const independent = tree.insert(createNode({ name: 'Owner-operated Flats' }));
    assert.deepEqual(independent.path, []);
    assert.equal(tree.roots().length, 1);
  });

  test('merging keeps the old id resolvable', () => {
    const { tree, property } = seed();
    const duplicate = tree.insert(createNode({ name: 'The Maple Apartments' }));
    tree.merge(duplicate.id, property.id);

    assert.equal(tree.get(duplicate.id).status, 'merged');
    assert.equal(tree.resolve(duplicate.id).id, property.id, 'a stale reference still lands on the live record');
  });

  test('describes a property with its chain', () => {
    const { tree, property } = seed();
    assert.equal(tree.describe(property.id), 'The Maple — North Texas — Alder Residential');
  });
});

describe('natural key', () => {
  test('two properties with the same name in different cities stay separate', () => {
    const a = naturalKey({ name: 'The Maple', address: { city: 'Dallas', line1: '100 Main St' } });
    const b = naturalKey({ name: 'The Maple', address: { city: 'Austin', line1: '100 Main St' } });
    assert.notEqual(a, b);
  });

  test('formatting differences between a CRM and a crawler still match', () => {
    const a = naturalKey({ name: 'The Maple Apartments', address: { city: 'Dallas', line1: '100 Main Street' } });
    const b = naturalKey({ name: 'Maple', address: { city: 'dallas', line1: '100 Main St.' } });
    assert.equal(a, b);
  });
});

// ── titles ──────────────────────────────────────────────────────────────────

describe('title normalization', () => {
  const cases = [
    ['Property Manager', 'manager'],
    ['Community Manager', 'manager'],
    ['Business Manager', 'manager'],
    ['Assistant Property Manager', 'assistant_manager'],
    ['Asst. Mgr', 'assistant_manager'],
    ['APM', 'assistant_manager'],
    ['Leasing Manager', 'leasing'],
    ['Leasing Consultant', 'leasing'],
    ['Regional Manager', 'regional'],
    ['VP of Operations', 'corporate'],
    ['Maintenance Supervisor', 'maintenance'],
    ['Leasing Office', 'office'],
  ];
  for (const [raw, expected] of cases) {
    test(`"${raw}" → ${expected}`, () => assert.equal(normalizeTitle(raw).role, expected));
  }

  test('a leasing manager is not the property manager', () => {
    assert.ok(normalizeTitle('Leasing Manager').level > normalizeTitle('Property Manager').level);
  });

  test('an unknown title stays unknown rather than being guessed at', () => {
    const result = normalizeTitle('Resident Experience Curator');
    assert.equal(result.role, 'unknown');
    assert.equal(result.level, null);
    assert.equal(result.confident, false);
    assert.equal(result.raw, 'Resident Experience Curator', 'the original is kept');
  });

  test('an office inbox is recognized as not-a-person', () => {
    assert.equal(isOffice({ role: 'office' }), true);
    assert.equal(isOffice({ displayName: 'Sarah Chen', channels: [{ kind: 'email', value: 'sarah@x.com' }] }), false);
    assert.equal(isOffice({ displayName: 'The Maple', channels: [{ kind: 'email', value: 'leasing@themaple.com' }] }), true);
  });

  test('authority ordering puts unknown titles last, not first', () => {
    const ordered = byAuthority([
      { name: 'mystery', level: null },
      { name: 'agent', level: 4 },
      { name: 'manager', level: 2 },
    ]);
    assert.deepEqual(ordered.map((c) => c.name), ['manager', 'agent', 'mystery']);
  });
});

describe('the default view is the office and the manager', () => {
  test('picks exactly those two out of a full roster', () => {
    const desk = frontDesk([
      { displayName: 'Front desk', role: 'office', level: 4 },
      { displayName: 'Dana', role: 'manager', level: 2 },
      { displayName: 'Kim', role: 'leasing', level: 4 },
      { displayName: 'Ray', role: 'maintenance', level: 6 },
    ]);
    assert.equal(desk.office.displayName, 'Front desk');
    assert.equal(desk.manager.displayName, 'Dana');
    assert.equal(desk.otherCount, 2, 'the rest are counted, not listed');
  });

  test('falls down the ladder when there is no manager on file', () => {
    const desk = frontDesk([{ displayName: 'Kim', role: 'leasing', level: 4 }]);
    assert.equal(desk.manager.displayName, 'Kim');
  });

  test('never surfaces someone who has left', () => {
    const desk = frontDesk([
      { displayName: 'Gone', role: 'manager', level: 2, status: 'departed' },
      { displayName: 'Here', role: 'leasing', level: 4, status: 'active' },
    ]);
    assert.equal(desk.manager.displayName, 'Here');
  });
});

// ── contacts and turnover ───────────────────────────────────────────────────

describe('contacts and assignments', () => {
  test('channels normalize on the way in', () => {
    assert.equal(normalizeChannelValue('email', '  Leasing@TheMaple.COM '), 'leasing@themaple.com');
    assert.equal(normalizeChannelValue('phone', '(214) 555-0184'), '+12145550184');
    assert.equal(normalizeChannelValue('instagram', '@TheMaple_Living'), 'themaple_living');
    assert.equal(normalizeChannelValue('phone', '555'), null, 'a partial number is worse than none');
  });

  test('an office line with an extension keeps the base number', () => {
    assert.equal(normalizeChannelValue('phone', '214-555-0184 x203'), '+12145550184');
  });

  test('moving properties ends the old assignment instead of erasing it', () => {
    const roster = createRoster();
    const kim = roster.addContact(createContact({ displayName: 'Kim R', rawTitle: 'Leasing Consultant' }));

    roster.assign(kim.id, 'prop-a', { startedAt: '2025-01-01T00:00:00.000Z' });
    roster.assign(kim.id, 'prop-b', { startedAt: '2025-09-01T00:00:00.000Z' });

    assert.equal(roster.at('prop-a').length, 0, 'not there now');
    assert.equal(roster.at('prop-b').length, 1, 'there now');
    assert.equal(
      roster.at('prop-a', { asOf: '2025-03-01T00:00:00.000Z' })[0]?.displayName,
      'Kim R',
      'but she was there in March, and that stays true',
    );
  });

  test('the same person can outrank themselves at a different property', () => {
    const roster = createRoster();
    const dana = roster.addContact(createContact({ displayName: 'Dana P', rawTitle: 'Leasing Consultant' }));
    roster.assign(dana.id, 'prop-a', { keepOthers: true });
    roster.assign(dana.id, 'prop-b', { role: 'manager', level: 2, keepOthers: true });

    assert.equal(roster.at('prop-a')[0].role, 'leasing');
    assert.equal(roster.at('prop-b')[0].role, 'manager');
  });

  test('departing clears current assignments without deleting history', () => {
    const roster = createRoster();
    const sam = roster.addContact(createContact({ displayName: 'Sam T', rawTitle: 'Property Manager' }));
    roster.assign(sam.id, 'prop-a', { startedAt: '2025-01-01T00:00:00.000Z' });
    roster.markDeparted(sam.id, '2026-01-01T00:00:00.000Z');

    assert.equal(roster.at('prop-a').length, 0);
    assert.equal(roster.at('prop-a', { asOf: '2025-06-01T00:00:00.000Z' }).length, 1);
    assert.equal(roster.getContact(sam.id).status, 'departed');
  });

  test('unrecognized titles collect into a review list', () => {
    const roster = createRoster();
    roster.addContact(createContact({ displayName: 'A', rawTitle: 'Vibe Director' }));
    roster.addContact(createContact({ displayName: 'B', rawTitle: 'Vibe Director' }));
    roster.addContact(createContact({ displayName: 'C', rawTitle: 'Property Manager' }));

    const unknown = roster.unrecognizedTitles();
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].count, 2);
  });

  test('a nameless row with an office email becomes the office, not a person', () => {
    const contact = createContact({
      displayName: 'The Maple',
      channels: [{ kind: 'email', value: 'leasing@themaple.com' }],
    });
    assert.equal(contact.role, 'office');
  });
});

// ── CSV ─────────────────────────────────────────────────────────────────────

describe('csv parsing', () => {
  test('survives quotes, embedded commas, and newlines', () => {
    const text = 'Property,Notes\n"The Maple, Uptown","line one\nline two"\n"He said ""yes""",ok';
    const { rows } = parseCsv(text);
    assert.equal(rows[0].Property, 'The Maple, Uptown');
    assert.equal(rows[0].Notes, 'line one\nline two');
    assert.equal(rows[1].Property, 'He said "yes"');
  });

  test('sniffs tabs and semicolons', () => {
    assert.equal(sniffDelimiter('a\tb\tc'), '\t');
    assert.equal(sniffDelimiter('a;b;c'), ';');
    assert.equal(sniffDelimiter('a,b,c'), ',');
    assert.equal(sniffDelimiter('"a,b"\tc'), '\t', 'a comma inside quotes does not vote');
  });

  test('strips a BOM and handles CRLF', () => {
    const { headers, rows } = parseCsv('﻿Name,City\r\nThe Maple,Dallas\r\n');
    assert.deepEqual(headers, ['Name', 'City']);
    assert.equal(rows[0].Name, 'The Maple');
    assert.equal(rows.length, 1, 'the trailing blank line is not a row');
  });

  test('round-trips through toCsv', () => {
    const rows = [{ Name: 'The Maple, Uptown', Notes: 'said "hi"' }];
    const { rows: back } = parseCsv(toCsv(rows));
    assert.deepEqual(back, rows);
  });
});

// ── import ──────────────────────────────────────────────────────────────────

const CRM_EXPORT = [
  'Community,Address,City,ST,Zip,Units,Management Co,First Name,Last Name,Title,Email,Phone',
  'The Maple,100 Main St,Dallas,TX,75204,240,Alder Residential,Dana,Price,Property Manager,dana@alderres.com,214-555-0101',
  'The Maple,100 Main St,Dallas,TX,75204,240,Alder Residential,Kim,Ruiz,Leasing Consultant,kim@alderres.com,214-555-0102',
  'The Maple,100 Main St,Dallas,TX,75204,240,Alder Residential,,,Leasing Office,leasing@themaple.com,214-555-0100',
  'Cedar Row,88 Oak Ave,Dallas,TX,75219,120,Alder Residential,Sam,Tran,Asst. Mgr,sam@alderres.com,214-555-0201',
  'Lark House,55 Elm Blvd,Fort Worth,TX,76102,310,Cedar Group,Ray,Ortiz,Resident Experience Curator,ray@cedargrp.com,817-555-0301',
  ',999 Nowhere Ln,Dallas,TX,75201,90,Alder Residential,Pat,Lee,Leasing Consultant,pat@alderres.com,214-555-0999',
  ',,,,,,,,,,,',
].join('\n');

describe('crm import', () => {
  test('detects columns from human-written headers', () => {
    const { headers } = parseCsv(CRM_EXPORT);
    const { mapping, missingRequired } = detectMapping(headers);
    assert.deepEqual(missingRequired, []);
    assert.equal(mapping.propertyName, 'Community');
    assert.equal(mapping.state, 'ST');
    assert.equal(mapping.managementCompany, 'Management Co');
    assert.equal(mapping.contactTitle, 'Title');
  });

  test('an explicit mapping overrides detection', () => {
    const { mapping } = detectMapping(['Site Code', 'Whatever'], { propertyName: 'Site Code' });
    assert.equal(mapping.propertyName, 'Site Code');
  });

  test('builds properties, companies, contacts, and assignments in one pass', () => {
    const directory = createDirectory();
    const report = directory.importCrm({ text: CRM_EXPORT });

    assert.equal(report.properties.created, 3);
    assert.equal(report.companies.created, 2);
    assert.equal(report.contacts.created, 5);

    const stats = directory.stats();
    assert.equal(stats.properties, 3);
    assert.equal(stats.companies, 2);
  });

  test('properties land under their management company', () => {
    const directory = createDirectory();
    directory.importCrm({ text: CRM_EXPORT });
    const maple = directory.search('maple')[0];
    assert.deepEqual(maple.under.map((u) => u.name), ['Alder Residential']);
  });

  test('the default view resolves to the office and the manager', () => {
    const directory = createDirectory();
    directory.importCrm({ text: CRM_EXPORT });
    const maple = directory.search('maple')[0];

    assert.equal(maple.manager.name, 'Dana Price');
    assert.equal(maple.office.email, 'leasing@themaple.com');
    assert.equal(maple.otherContacts, 1, 'the leasing consultant is counted, not surfaced');
  });

  test('re-importing the same export changes nothing', () => {
    const directory = createDirectory();
    directory.importCrm({ text: CRM_EXPORT });
    const before = directory.stats();

    const second = directory.importCrm({ text: CRM_EXPORT });
    const after = directory.stats();

    assert.deepEqual(after, before, 'an export gets re-pulled constantly; that must be safe');
    assert.equal(second.properties.created, 0);
    assert.equal(second.contacts.created, 0);
    assert.equal(second.properties.matched, 5, 'every row matched an existing property');
  });

  test('a dry run writes nothing but reports everything', () => {
    const directory = createDirectory();
    const report = directory.importCrm({ text: CRM_EXPORT }, { dryRun: true });

    assert.equal(report.dryRun, true);
    assert.equal(report.properties.created, 3, 'it still says what it would do');
    assert.equal(directory.stats().properties, 0, 'and does none of it');
  });

  test('unrecognized titles are reported, not silently ranked', () => {
    const directory = createDirectory();
    const report = directory.importCrm({ text: CRM_EXPORT });
    assert.ok(report.unrecognizedTitles.some((t) => /Resident Experience Curator/i.test(t.rawTitle)));
  });

  test('a row with data but no property name is skipped with a reason', () => {
    const directory = createDirectory();
    const report = directory.importCrm({ text: CRM_EXPORT });

    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /no property name/);
    assert.equal(report.skipped[0].row, 7, 'reported by spreadsheet row number, so it can be found');
    assert.ok(report.skipped[0].data, 'and carried back, so it can be corrected and re-fed');
  });

  test('a wholly blank line is not reported as a problem', () => {
    const directory = createDirectory();
    const report = directory.importCrm({ text: CRM_EXPORT });
    assert.equal(report.rows, 6, 'the blank trailing line is not counted as a row at all');
  });

  test('a re-import never blanks a known value with an empty column', () => {
    const directory = createDirectory();
    directory.importCrm({ text: CRM_EXPORT });

    const thin = 'Community,Address,City\nThe Maple,,\n';
    directory.importCrm({ text: thin });

    const maple = directory.search('maple')[0];
    assert.equal(maple.address.line1, '100 Main St', 'the blank did not erase it');
  });

  test('a missing property-name column fails loudly with the fix', () => {
    const directory = createDirectory();
    const report = directory.importCrm({ text: 'Foo,Bar\n1,2\n' });
    assert.deepEqual(report.missingRequired, ['propertyName']);
    assert.match(report.skipped[0].reason, /--map propertyName/);
  });
});

// ── party separation ────────────────────────────────────────────────────────

describe('separating industry contacts from customers', () => {
  function seeded() {
    const directory = createDirectory();
    directory.importCrm({ text: CRM_EXPORT });
    const roster = directory.roster;
    const dana = roster.allContacts().find((c) => c.displayName === 'Dana Price');
    dana.channels.push({ kind: 'instagram', value: 'dana.at.themaple' });
    directory.party.rebuild();
    return directory;
  }

  test('a known contact is identified with certainty and their property', () => {
    const result = seeded().identify({ handle: '@dana.at.themaple' });
    assert.equal(result.party, 'industry');
    assert.equal(result.confidence, 'certain');
    assert.equal(result.matchedOn, 'instagram');
    assert.equal(result.node.name, 'The Maple');
    assert.match(result.reason, /property manager at The Maple/i);
  });

  test('email and phone match too', () => {
    const directory = seeded();
    assert.equal(directory.identify({ email: 'KIM@alderres.com' }).confidence, 'certain');
    assert.equal(directory.identify({ phone: '(214) 555-0102' }).confidence, 'certain');
  });

  test('an unknown sender is left alone', () => {
    const result = seeded().identify({ handle: '@jessicarenter' });
    assert.equal(result.party, 'unknown');
    assert.equal(result.confidence, 'none');
  });

  test('a management domain is probable, never certain', () => {
    const result = seeded().identify({ email: 'newhire@alderres.com' });
    assert.equal(result.party, 'industry');
    assert.equal(result.confidence, 'probable');
    assert.match(result.reason, /confirm before treating as industry/);
  });

  test('a free-mail domain identifies nobody', () => {
    const directory = createDirectory();
    directory.importCrm({ text: 'Community,First Name,Last Name,Title,Email\nThe Maple,Dana,Price,Property Manager,dana@gmail.com\n' });
    const result = directory.identify({ email: 'someone.else@gmail.com' });
    assert.equal(result.party, 'unknown', 'one agent on gmail must not brand every gmail user as industry');
  });

  test('the resolver hands back the shape the lead ingestor expects', () => {
    const resolve = seeded().partyResolver();
    const result = resolve({ handle: 'dana.at.themaple' });
    assert.equal(typeof result.party, 'string');
    assert.equal(typeof result.confidence, 'string');
    assert.equal(typeof result.reason, 'string');
  });

  test('a departed contact still resolves — old messages need explaining too', () => {
    const directory = seeded();
    const dana = directory.roster.allContacts().find((c) => c.displayName === 'Dana Price');
    directory.roster.markDeparted(dana.id);
    directory.party.rebuild();

    const result = directory.identify({ email: 'dana@alderres.com' });
    assert.equal(result.party, 'industry');
  });
});

// ── crawler seam ────────────────────────────────────────────────────────────

describe('crawler seam', () => {
  const discovered = [
    {
      name: 'Birch Court',
      address: { line1: '12 Pine St', city: 'Dallas', state: 'TX' },
      website: 'https://birchcourt.example',
      managementCompany: 'Cedar Group',
      contacts: [{ name: 'Tia Nguyen', title: 'Property Manager', email: 'tia@cedargrp.com' }],
      url: 'https://birchcourt.example/staff',
    },
    { name: 'Rejected Place', url: 'https://example.com/x' },
  ];

  test('records flow through the same path as a CRM import', () => {
    const directory = createDirectory();
    const report = directory.ingestDiscovered(discovered);
    assert.equal(report.properties.created, 2);
    assert.equal(directory.search('birch')[0].manager.name, 'Tia Nguyen');
  });

  test('the policy hook is where the crawler owner attaches guardrails', () => {
    const directory = createDirectory();
    const report = directory.ingestDiscovered(discovered, {
      policy: (record) => (record.name === 'Rejected Place' ? { accept: false, reason: 'not in market' } : { accept: true }),
    });

    assert.equal(report.properties.created, 1);
    assert.deepEqual(report.rejected, [{ name: 'Rejected Place', reason: 'not in market' }]);
  });

  test('a property with no contacts is still recorded', () => {
    const { rows } = acceptDiscovered([{ name: 'Empty Place' }], {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].contactName, '');
  });

  test('crawled records carry their own provenance', () => {
    const directory = createDirectory();
    directory.ingestDiscovered(discovered, { sourceName: 'property-crawler' });
    const node = directory.tree.all().find((n) => n.name === 'Birch Court');
    assert.equal(node.sources[0].source, 'property-crawler');
  });
});

// ── the work list ───────────────────────────────────────────────────────────

describe('gaps', () => {
  test('names what each property is missing rather than scoring completeness', () => {
    const directory = createDirectory();
    directory.importCrm({ text: CRM_EXPORT });

    const gaps = directory.gaps();
    const cedar = gaps.find((g) => g.name === 'Cedar Row');
    assert.ok(cedar.missing.includes('no leasing office contact'));

    const maple = gaps.find((g) => g.name === 'The Maple');
    assert.equal(maple, undefined, 'The Maple has both, so it is not on the list');
  });
});
