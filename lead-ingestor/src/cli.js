#!/usr/bin/env node
/**
 * Lead ingestor command line.
 *
 *   node src/cli.js inspect-archive --path ~/Downloads/instagram-export
 *   node src/cli.js import-archive  --path ~/Downloads/instagram-export --me "His Name" \
 *                                   --store data/leads.json --corpus-out data/voice-corpus.jsonl
 *   node src/cli.js triage --text "looking for a 2 bed in uptown under 2k"
 *   node src/cli.js leads [--disposition prospective_renter]
 *   node src/cli.js sheet <personId>
 *   node src/cli.js health
 *
 * `inspect-archive` is always the first command to run against a new export: it
 * reports what is in there and, critically, which display name is the account
 * owner — everything downstream depends on getting that right.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createIngestor, DISPOSITIONS } from './index.js';
import { createFileStore } from './store/index.js';
import { readArchive, archiveToEvents, archiveToVoiceCorpus, describeArchive } from './sources/archive.js';
import { renderProspectSheet } from './enrichment/prospect-sheet.js';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'help';

const commands = {
  'inspect-archive': inspectArchive,
  'import-archive': importArchive,
  triage: triageText,
  leads,
  people,
  sheet,
  health,
  help,
};
await (commands[command] ?? help)();

// ---------------------------------------------------------------- commands --

async function inspectArchive() {
  const path = requirePath();
  const summary = describeArchive(path);

  console.log(bold('\ninstagram export\n'));
  console.log(`  location        ${path}`);
  console.log(`  inbox folders   ${summary.inboxes.length}`);
  console.log(`  threads         ${summary.threadCount} (${summary.groupThreads} group)`);
  console.log(`  messages        ${summary.messageCount.toLocaleString()}`);
  if (summary.dateRange) console.log(`  date range      ${summary.dateRange.from} to ${summary.dateRange.to}`);

  const owner = summary.likelyOwner;
  if (owner) {
    console.log(`\n${bold('account owner')}`);
    console.log(`  ${owner.name}   ${dim(`in ${owner.inThreads} of ${owner.ofThreads} threads, ${owner.messages.toLocaleString()} messages`)}`);
    if (!owner.certain) {
      console.log(dim('  Not certain — check the list below and pass the right name to --me.'));
    }
  }

  console.log(`\n${bold('who appears in the most threads')}`);
  for (const candidate of summary.candidates) {
    console.log(
      `  ${String(candidate.threads).padStart(5)} threads  ${String(candidate.messages).padStart(7)} msgs  ${candidate.name}`,
    );
  }
  console.log(
    `\n${dim('Next:')} node src/cli.js import-archive --path "${path}" --me "${owner?.name ?? 'His Name'}" --store data/leads.json --corpus-out data/voice-corpus.jsonl\n`,
  );
}

async function importArchive() {
  const path = requirePath();
  const meName = args.me;
  if (!meName) {
    console.error('--me "Display Name" is required. Run inspect-archive first to see the exact spelling.');
    process.exitCode = 1;
    return;
  }

  const threads = readArchive(path, { includeGroups: Boolean(args.groups) });
  const events = archiveToEvents(threads, { meName, since: args.since });

  if (!events.length) {
    console.error(
      `no inbound messages found for an owner named "${meName}". ` +
        `Check the spelling against inspect-archive — it must match exactly.`,
    );
    process.exitCode = 1;
    return;
  }

  // A historical import must not fire handoffs: these conversations already
  // happened, and replying to a two-year-old DM would be worse than useless.
  const store = args.store ? createFileStore({ path: args.store }) : undefined;
  const ingestor = createIngestor({
    store,
    market: args.market ? { areas: String(args.market).split(',').map((s) => s.trim()) } : undefined,
    logger: args.verbose ? consoleLogger() : undefined,
  });

  console.log(bold(`\nimporting ${events.length.toLocaleString()} inbound messages from ${threads.length} threads…\n`));
  const results = await ingestor.ingest(events);

  const counts = {};
  for (const result of results) {
    const key = result.triage.disposition;
    counts[key] = (counts[key] ?? 0) + 1;
  }

  const stats = await ingestor.stats();
  console.log(`  people          ${stats.people}`);
  console.log(`  leads           ${stats.leads}`);
  console.log(`  events stored   ${stats.events}\n`);
  console.log(bold('  how the threads classified'));
  for (const disposition of Object.values(DISPOSITIONS)) {
    const count = stats.byDisposition[disposition] ?? 0;
    if (count) console.log(`    ${disposition.padEnd(22)} ${String(count).padStart(6)}`);
  }

  if (args['corpus-out']) {
    const corpus = archiveToVoiceCorpus(threads, { meName });
    mkdirSync(dirname(args['corpus-out']), { recursive: true });
    writeFileSync(args['corpus-out'], corpus.map((pair) => JSON.stringify(pair)).join('\n') + '\n');
    const paired = corpus.filter((c) => c.lead).length;
    console.log(`\n  voice corpus    ${corpus.length.toLocaleString()} of his messages (${paired.toLocaleString()} paired with what they replied to)`);
    console.log(`                  written to ${args['corpus-out']}`);
    console.log(dim(`\n  Build his voice profile with:`));
    const corpusPath = args['corpus-out'].startsWith('/')
      ? args['corpus-out']
      : `../lead-ingestor/${args['corpus-out']}`;
    console.log(
      dim(`    cd ../leasing-reply-engine && npm run learn -- --corpus ${corpusPath} --id his-voice --out src/voice/profiles/his-voice.json`),
    );
  }

  if (store) {
    store.flushNow();
    console.log(`\n  saved to        ${args.store}`);
  }
  console.log();
}

async function triageText() {
  const text = args.text ?? args._.slice(1).join(' ');
  if (!text) {
    console.error('usage: triage --text "the message"');
    process.exitCode = 1;
    return;
  }
  const ingestor = createIngestor({
    market: args.market ? { areas: String(args.market).split(',').map((s) => s.trim()) } : undefined,
  });
  const result = ingestor.triage.classify({ text });

  console.log(`\n  ${bold(result.disposition)}${result.needsHuman ? dim('  (needs a human)') : ''}`);
  console.log(`  ${dim(`classifier confidence ${result.confidence}`)}`);
  for (const reason of result.reasons) console.log(`    · ${reason}`);
  if (result.signals.length) {
    console.log(`\n  ${bold('signals')}`);
    for (const signal of result.signals) console.log(`    ${signal.kind.padEnd(24)} "${signal.evidence}"`);
  }
  if (result.missing.length) console.log(`\n  ${bold('still unknown')}  ${result.missing.join(', ')}`);
  console.log();
}

async function leads() {
  const ingestor = openStored();
  const list = await ingestor.store.listLeads({
    disposition: args.disposition,
    limit: Number(args.limit) || 40,
  });
  if (!list.length) return console.log(dim('\nno leads stored. Run import-archive first, or pass --store <path>.\n'));

  console.log();
  for (const lead of list) {
    const person = await ingestor.store.getPerson(lead.personId);
    const handle = person?.identifiers.find((i) => i.kind === 'instagram_handle')?.value;
    console.log(
      `  ${(lead.triage?.disposition ?? 'untriaged').padEnd(22)} ${(handle ? `@${handle}` : person?.displayName ?? lead.personId).padEnd(28)} ${dim(String(lead.lastSeenAt).slice(0, 10))}`,
    );
    if (args.why) for (const reason of lead.triage?.reasons ?? []) console.log(dim(`      · ${reason}`));
  }
  console.log();
}

async function people() {
  const ingestor = openStored();
  const list = await ingestor.store.listPeople({ limit: Number(args.limit) || 40 });
  console.log();
  for (const person of list) {
    const handle = person.identifiers.find((i) => i.kind === 'instagram_handle')?.value;
    console.log(`  ${person.id.padEnd(20)} ${(handle ? `@${handle}` : person.displayName ?? '—').padEnd(28)} ${dim(`${person.facts.length} facts`)}`);
  }
  console.log();
}

async function sheet() {
  const personId = args._[1] ?? args.person;
  if (!personId) {
    console.error('usage: sheet <personId>   (list ids with: people)');
    process.exitCode = 1;
    return;
  }
  const ingestor = openStored();
  const result = await ingestor.prospectSheet(personId);
  if (!result) {
    console.error(`no person with id ${personId}`);
    process.exitCode = 1;
    return;
  }
  console.log(args.json ? JSON.stringify(result, null, 2) : `\n${renderProspectSheet(result)}\n`);
}

async function health() {
  const ingestor = openStored();
  const report = await ingestor.health();
  if (!Object.keys(report).length) {
    return console.log(dim('\nno sources registered. Sources are wired up in code — see README.\n'));
  }
  console.log();
  for (const [name, status] of Object.entries(report)) {
    console.log(`  ${name.padEnd(14)} ${status.status.padEnd(14)} ${dim(status.detail ?? '')}`);
  }
  console.log();
}

async function help() {
  console.log(`
${bold('lead ingestor')}

  ${bold('inspect-archive')} --path <dir>
      Report what is in an Instagram export and which name is the account owner.
      Always run this first.

  ${bold('import-archive')} --path <dir> --me "Display Name"
      Ingest every inbound message from the export as historical leads.
      --store <file.json>        persist the results
      --corpus-out <file.jsonl>  also write a voice corpus for the reply engine
      --since <YYYY-MM-DD>       only messages after this date
      --groups                   include group threads (off by default)
      --market "uptown,downtown" flag areas outside the service market

  ${bold('triage')} --text "..."
      Classify one message and show the signals behind the call.

  ${bold('leads')} [--disposition X] [--why]      ${bold('people')}      ${bold('sheet')} <personId> [--json]
  ${bold('health')}
      Anything reading stored data takes --store <file.json>.
`);
}

// ----------------------------------------------------------------- helpers --

function openStored() {
  return createIngestor({
    store: args.store ? createFileStore({ path: args.store }) : undefined,
  });
}

function requirePath() {
  const path = args.path ?? args._[1];
  if (!path) {
    console.error('--path <unzipped export folder> is required');
    process.exit(1);
  }
  return String(path).replace(/^~/, process.env.HOME ?? '~');
}

function consoleLogger() {
  const at = (level) => (msg, fields) => console.error(`[${level}] ${msg}`, fields ?? '');
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: consoleLogger };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(arg);
  }
  return out;
}

function useColor() {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}
function dim(s) {
  return useColor() ? `\x1b[2m${s}\x1b[0m` : s;
}
function bold(s) {
  return useColor() ? `\x1b[1m${s}\x1b[0m` : s;
}
