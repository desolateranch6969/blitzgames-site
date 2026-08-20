import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  readArchive,
  archiveToEvents,
  archiveToVoiceCorpus,
  describeArchive,
  decodeExportText,
  findInboxDirs,
  handleFromThreadId,
} from '../src/sources/archive.js';
import { createArchiveSource } from '../src/sources/archive.js';
import { makeExport, sampleExport, mojibake, ME } from './fixtures.js';

const fixture = sampleExport();
after(() => fixture.cleanup());

describe('reading an instagram export', () => {
  test('finds the inbox wherever the export was unzipped', () => {
    const inboxes = findInboxDirs(fixture.root);
    assert.equal(inboxes.length, 1);
    assert.ok(inboxes[0].endsWith(join('messages', 'inbox')));
  });

  test('explains itself when pointed at the wrong folder', () => {
    assert.throws(() => readArchive('/tmp/definitely-not-an-export'), /messages\/inbox/);
  });

  test('repairs the latin-1 mojibake meta writes into exports', () => {
    assert.equal(decodeExportText(mojibake('i’ll send it over — 4 weeks free')), 'i’ll send it over — 4 weeks free');
    assert.equal(decodeExportText('already clean'), 'already clean');
    assert.equal(decodeExportText(''), '');
  });

  test('restores chronological order across chunk files', () => {
    const day = 86_400_000;
    const base = Date.parse('2026-01-01T00:00:00Z');
    const many = makeExport({
      me: ME,
      chunkSize: 2, // force message_1..message_3
      threads: [
        {
          folder: 'someone_17841400000000009',
          title: 'Someone',
          messages: [
            { sender: 'Someone', text: 'first', at: base },
            { sender: ME, text: 'second', at: base + day },
            { sender: 'Someone', text: 'third', at: base + 2 * day },
            { sender: ME, text: 'fourth', at: base + 3 * day },
            { sender: 'Someone', text: 'fifth', at: base + 4 * day },
          ],
        },
      ],
    });

    try {
      const [thread] = readArchive(many.root);
      assert.deepEqual(
        thread.messages.map((m) => m.text),
        ['first', 'second', 'third', 'fourth', 'fifth'],
        'chunks must be concatenated and re-sorted, not read in file order',
      );
    } finally {
      many.cleanup();
    }
  });

  test('skips group threads unless asked for them', () => {
    assert.equal(readArchive(fixture.root).length, 5);
    assert.equal(readArchive(fixture.root, { includeGroups: true }).length, 6);
  });

  test('identifies the account owner by thread presence, not message volume', () => {
    const summary = describeArchive(fixture.root);
    assert.equal(summary.threadCount, 6);
    assert.equal(summary.likelyOwner.name, ME, 'the owner is in every thread even when a lead types more');
    assert.equal(summary.likelyOwner.inThreads, 6);
    assert.equal(summary.likelyOwner.certain, true);
    assert.ok(summary.dateRange.from <= summary.dateRange.to);
  });

  test('says so when the owner is ambiguous rather than guessing', () => {
    const ambiguous = makeExport({
      me: ME,
      threads: [
        { folder: 'a_17841400000000021', title: 'A', participants: ['A', 'B'], messages: [{ sender: 'A', text: 'hi', at: 1 }] },
        { folder: 'b_17841400000000022', title: 'C', participants: ['C', 'D'], messages: [{ sender: 'C', text: 'hi', at: 2 }] },
      ],
    });
    try {
      assert.equal(describeArchive(ambiguous.root).likelyOwner.certain, false);
    } finally {
      ambiguous.cleanup();
    }
  });

  test('recovers a handle from an export folder name', () => {
    assert.equal(handleFromThreadId('jessicarenter_17841400000000001'), 'jessicarenter');
    assert.equal(handleFromThreadId('nothing-useful'), undefined);
  });
});

describe('archive to events', () => {
  const threads = readArchive(fixture.root);
  const events = archiveToEvents(threads, { meName: ME });

  test('only the other party becomes a lead event', () => {
    assert.ok(events.length > 0);
    assert.equal(events.some((e) => e.actor.displayName === ME), false, 'his own messages are context, not leads');
  });

  test('events carry provenance and are ordered oldest first', () => {
    for (const event of events) {
      assert.equal(event.source, 'archive');
      assert.equal(event.payload.fromArchive, true);
      assert.ok(event.occurredAt, 'every event needs a time');
    }
    const times = events.map((e) => e.occurredAt);
    assert.deepEqual(times, [...times].sort());
  });

  test('a since filter trims history', () => {
    const recent = archiveToEvents(threads, { meName: ME, since: '2026-03-04' });
    assert.ok(recent.length < events.length);
    assert.ok(recent.every((e) => e.occurredAt >= '2026-03-04'));
  });

  test('ids are stable, so re-importing the same export changes nothing', () => {
    const again = archiveToEvents(readArchive(fixture.root), { meName: ME });
    assert.deepEqual(again.map((e) => e.id), events.map((e) => e.id));
  });
});

describe('archive to voice corpus', () => {
  const threads = readArchive(fixture.root);
  const corpus = archiveToVoiceCorpus(threads, { meName: ME });

  test('captures his messages, paired with what he was replying to', () => {
    assert.ok(corpus.length >= 2);
    const paired = corpus.find((c) => c.lead);
    assert.match(paired.lead, /looking for a 2 bed/);
    assert.match(paired.agent, /when are you trying to move/);
  });

  test('a reply long after the last inbound is not treated as an answer to it', () => {
    const stale = makeExport({
      me: ME,
      threads: [
        {
          folder: 'gap_17841400000000010',
          title: 'Gap',
          messages: [
            { sender: 'Gap', text: 'you around?', at: Date.parse('2026-01-01T00:00:00Z') },
            { sender: ME, text: 'hey sorry just seeing this', at: Date.parse('2026-01-05T00:00:00Z') },
          ],
        },
      ],
    });
    try {
      const pairs = archiveToVoiceCorpus(readArchive(stale.root), { meName: ME });
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0].lead, undefined, 'four days later is not a reply');
    } finally {
      stale.cleanup();
    }
  });

  test('is shaped for the reply engine learn command', () => {
    for (const pair of corpus) {
      assert.equal(typeof pair.agent, 'string');
      assert.ok(pair.lead === undefined || typeof pair.lead === 'string');
    }
  });
});

describe('archive as a source', () => {
  test('drains once and then reports itself healthy', async () => {
    const source = createArchiveSource({ path: fixture.root, meName: ME });
    const first = await source.poll();
    const second = await source.poll();
    assert.ok(first.length > 0);
    assert.deepEqual(second, [], 'a one-shot backfill must not re-emit on every poll');
    assert.equal((await source.health()).status, 'ok');
  });

  test('reports unconfigured rather than throwing on a bad path', async () => {
    const source = createArchiveSource({ path: '/tmp/nope-not-here', meName: ME });
    assert.equal((await source.health()).status, 'unconfigured');
  });
});
