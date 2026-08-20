#!/usr/bin/env node
/**
 * Property directory command line.
 *
 *   node src/cli.js inspect --file export.csv
 *   node src/cli.js import  --file export.csv --dry-run
 *   node src/cli.js import  --file export.csv --store data/directory.json
 *   node src/cli.js tree    --store data/directory.json
 *   node src/cli.js who     "the maple" --store data/directory.json
 *   node src/cli.js gaps    --store data/directory.json
 *
 * `inspect` before `import`, always. It shows which column the importer thinks
 * is which, without writing anything.
 */
import { readFileSync } from 'node:fs';
import { createDirectory, createFileStore, parseCsv, detectMapping, renderReport } from './index.js';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'help';

const commands = { inspect, 'import': runImport, tree, who, gaps, escalate, help };
await (commands[command] ?? help)();

// ---------------------------------------------------------------- commands --

async function inspect() {
  const text = readFileSync(requireFile(), 'utf8');
  const { headers, rows } = parseCsv(text);
  const { mapping, unmapped, missingRequired } = detectMapping(headers, mapOverrides());

  console.log(bold('\ncolumns found\n'));
  for (const header of headers) {
    const field = Object.entries(mapping).find(([, h]) => h === header)?.[0];
    console.log(`  ${header.padEnd(28)} ${field ? dim('→ ' + field) : dim('(ignored)')}`);
  }

  console.log(bold(`\n${rows.length} data rows. First row reads:\n`));
  for (const [field, header] of Object.entries(mapping)) {
    const value = rows[0]?.[header] ?? '';
    if (value) console.log(`  ${field.padEnd(22)} ${value}`);
  }

  if (missingRequired.length) {
    console.log(
      `\n  ${bold('Nothing looks like a property name.')} Map it explicitly:\n` +
        `    --map propertyName="${headers[0] ?? 'Column'}"\n`,
    );
  } else {
    console.log(`\n${dim('Next:')} node src/cli.js import --file ${args.file} --dry-run\n`);
  }
}

async function runImport() {
  const file = requireFile();
  const text = readFileSync(file, 'utf8');
  const store = args.store ? createFileStore({ path: args.store }) : null;
  const directory = createDirectory({ store });

  const report = directory.importCrm(
    { text },
    {
      dryRun: Boolean(args['dry-run']),
      mapping: mapOverrides(),
      defaultManagementCompany: args.company,
      reconcile: Boolean(args.reconcile),
      source: { source: 'crm-import', reference: file, at: parseAsOf(args['as-of']) },
    },
  );

  console.log(renderReport(report));

  if (!args['dry-run'] && store) {
    store.save();
    const s = directory.stats();
    console.log(`  saved to             ${args.store}`);
    console.log(`  directory now holds  ${s.properties} properties, ${s.contacts} contacts`);
    console.log(`  with a manager       ${s.withManager} of ${s.properties}`);
    console.log(`  with an office line  ${s.withOffice} of ${s.properties}\n`);
  } else if (args['dry-run']) {
    console.log(`  ${dim('Nothing was written. Re-run without --dry-run to apply.')}\n`);
  }
}

async function tree() {
  const directory = open();
  const rendered = directory.tree.render();
  console.log(rendered ? `\n${rendered}\n` : dim('\nnothing in the directory yet\n'));
}

async function who() {
  const query = args._.slice(1).join(' ') || args.query;
  if (!query) {
    console.error('usage: who "property name"');
    process.exitCode = 1;
    return;
  }
  const directory = open();
  const matches = directory.search(query, { limit: 8 });
  if (!matches.length) return console.log(dim(`\nno property matching "${query}"\n`));

  for (const match of matches) {
    console.log(`\n${bold(match.name)}${match.address?.city ? dim(`  ${match.address.city}`) : ''}`);
    if (match.under.length) console.log(dim(`  under ${match.under.map((u) => u.name).join(' → ')}`));

    // The default view: the office and the manager. Nothing else, unless asked.
    console.log(`  ${'office'.padEnd(10)} ${format(match.office)}`);
    console.log(`  ${'manager'.padEnd(10)} ${format(match.manager)}`);
    if (match.otherContacts) console.log(dim(`  +${match.otherContacts} other contact(s) — use --all`));

    if (args.all) {
      console.log(dim('\n  everyone on file'));
      for (const c of directory.contactsAt(match.id)) {
        console.log(`    ${c.roleLabel.padEnd(18)} ${c.name.padEnd(24)} ${dim([c.email, c.phone].filter(Boolean).join('  '))}`);
      }
    }
  }
  console.log();
}

async function gaps() {
  const directory = open();
  const missing = directory.gaps();
  if (!missing.length) return console.log(dim('\nevery property has an office and a manager on file\n'));

  console.log(bold(`\n${missing.length} properties need filling in\n`));
  for (const g of missing.slice(0, Number(args.limit) || 30)) {
    console.log(`  ${g.name.padEnd(34)} ${dim(g.missing.join(', '))}`);
  }
  console.log();
}

async function escalate() {
  const contactId = args._[1] ?? args.contact;
  if (!contactId) {
    console.error('usage: escalate <contactId>');
    process.exitCode = 1;
    return;
  }
  const directory = open();
  const chain = directory.escalationFrom(contactId);
  if (!chain.length) return console.log(dim('\nnobody above this contact on file\n'));

  console.log(bold('\nescalation path\n'));
  for (const [i, c] of chain.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ${c.roleLabel.padEnd(18)} ${c.name.padEnd(24)} ${dim([c.email, c.phone].filter(Boolean).join('  '))}`);
  }
  console.log();
}

async function help() {
  console.log(`
${bold('property directory')}

  ${bold('inspect')} --file <export.csv>
      Show which column the importer thinks is which. Run this first.

  ${bold('import')} --file <export.csv>
      --dry-run                 report what would happen, write nothing
      --store <file.json>       where the directory lives
      --map <field>=<Column>    override a column mapping, repeatable
      --company "Name"          management company for rows that do not name one
      --as-of <YYYY-MM-DD>      when the export was generated, if not today
      --reconcile               treat absence as departure — only for a COMPLETE export

  ${bold('tree')}    --store <file.json>          the hierarchy
  ${bold('who')}     "property name" [--all]      the office and the manager
  ${bold('gaps')}    --store <file.json>          properties missing an office or manager
  ${bold('escalate')} <contactId>                 who sits above a contact
`);
}

// ----------------------------------------------------------------- helpers --

function open() {
  if (!args.store) {
    console.error('--store <file.json> is required for this command');
    process.exit(1);
  }
  return createDirectory({ store: createFileStore({ path: args.store }) });
}

function requireFile() {
  if (!args.file) {
    console.error('--file <export.csv> is required');
    process.exit(1);
  }
  return String(args.file).replace(/^~/, process.env.HOME ?? '~');
}

/** `--map propertyName=Community --map contactEmail="Email Address"` */
function mapOverrides() {
  const raw = args.map;
  if (!raw) return {};
  const entries = (Array.isArray(raw) ? raw : [raw])
    .map((pair) => String(pair).split('='))
    .filter((parts) => parts.length >= 2)
    .map(([field, ...rest]) => [field.trim(), rest.join('=').trim()]);
  return Object.fromEntries(entries);
}

/** An export generated earlier than today should say so. */
function parseAsOf(raw) {
  if (!raw || raw === true) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    console.error(`--as-of "${raw}" is not a date I can read. Use YYYY-MM-DD.`);
    process.exit(1);
  }
  return new Date(parsed).toISOString();
}

function format(contact) {
  if (!contact) return dim('— not on file —');
  const bits = [contact.name, contact.title ? `(${contact.title})` : '', contact.phone, contact.email].filter(Boolean);
  return bits.join('  ');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      const value = !next || next.startsWith('--') ? true : (i++, next);
      // Repeatable flags collect rather than overwrite.
      if (key in out) out[key] = [].concat(out[key], value);
      else out[key] = value;
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
