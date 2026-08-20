/**
 * A synthetic Instagram export, built on disk exactly the way Meta ships one —
 * including the two things that break naive readers: newest-first message order
 * split across numbered chunk files, and UTF-8 written as Latin-1 escapes.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Re-encode a normal string the way an Instagram export mangles it. */
export function mojibake(text) {
  return Buffer.from(text, 'utf8').toString('latin1');
}

/**
 * @param {{
 *   me?: string,
 *   threads: {folder: string, title: string, participants?: string[],
 *             messages: {sender: string, text?: string, at: number, photos?: any[]}[]}[],
 *   chunkSize?: number,
 * }} spec
 * @returns {{root: string, cleanup: () => void}}
 */
export function makeExport(spec) {
  const root = join(tmpdir(), `ig-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const inbox = join(root, 'your_instagram_activity', 'messages', 'inbox');
  mkdirSync(inbox, { recursive: true });

  const me = spec.me ?? 'Account Owner';
  const chunkSize = spec.chunkSize ?? 1000;

  for (const thread of spec.threads) {
    const dir = join(inbox, thread.folder);
    mkdirSync(dir, { recursive: true });

    // Exports are newest-first.
    const ordered = [...thread.messages].sort((a, b) => b.at - a.at);
    const chunks = [];
    for (let i = 0; i < ordered.length; i += chunkSize) chunks.push(ordered.slice(i, i + chunkSize));
    if (!chunks.length) chunks.push([]);

    chunks.forEach((chunk, index) => {
      writeFileSync(
        join(dir, `message_${index + 1}.json`),
        JSON.stringify({
          participants: (thread.participants ?? [thread.title, me]).map((name) => ({ name: mojibake(name) })),
          messages: chunk.map((m) => ({
            sender_name: mojibake(m.sender),
            timestamp_ms: m.at,
            ...(m.text != null ? { content: mojibake(m.text) } : {}),
            ...(m.photos ? { photos: m.photos } : {}),
          })),
          title: mojibake(thread.title),
          thread_path: `inbox/${thread.folder}`,
        }),
      );
    });
  }

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export const ME = 'Mike Locator';

/** A realistic mixed inbox: a good lead, a vendor pitch, spam, and a group. */
export function sampleExport() {
  const day = 86_400_000;
  const base = Date.parse('2026-03-01T15:00:00Z');

  return makeExport({
    me: ME,
    threads: [
      {
        folder: 'jessicarenter_17841400000000001',
        title: 'Jessica R',
        messages: [
          { sender: 'Jessica R', text: 'hey! saw your reel — looking for a 2 bed in uptown', at: base },
          { sender: ME, text: 'hey! when are you trying to move?', at: base + 60_000 },
          { sender: 'Jessica R', text: 'september 1st, budget around $2,000', at: base + 120_000 },
          { sender: ME, text: 'perfect — i’ll pull a list and send it over', at: base + 180_000 },
          { sender: 'Jessica R', text: 'my number is 214-555-0184', at: base + 240_000 },
        ],
      },
      {
        folder: 'growthguru_17841400000000002',
        title: 'Growth Guru',
        messages: [
          { sender: 'Growth Guru', text: 'Hey! I help realtors grow their following and get more leads. Interested?', at: base + day },
        ],
      },
      {
        folder: 'cryptoking_17841400000000003',
        title: 'Crypto King',
        messages: [{ sender: 'Crypto King', text: 'make $500 a day with bitcoin, dm me to start', at: base + 2 * day }],
      },
      {
        folder: 'davebuyer_17841400000000004',
        title: 'Dave B',
        messages: [
          { sender: 'Dave B', text: 'do you help people buy a house? im pre-approved for a mortgage', at: base + 3 * day },
        ],
      },
      {
        folder: 'quietone_17841400000000005',
        title: 'Sam Q',
        messages: [{ sender: 'Sam Q', text: 'hey', at: base + 4 * day }],
      },
      {
        folder: 'groupchat_17841400000000006',
        title: 'Weekend crew',
        participants: ['Person A', 'Person B', ME],
        messages: [{ sender: 'Person A', text: 'who’s coming saturday', at: base + 5 * day }],
      },
    ],
  });
}
