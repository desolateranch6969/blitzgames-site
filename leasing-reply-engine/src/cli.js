#!/usr/bin/env node
/**
 * Command line tools for the reply engine.
 *
 *   node src/cli.js chat                       Talk to it as if you were a lead.
 *   node src/cli.js voice --list               Show installed voice profiles.
 *   node src/cli.js voice --sample [--id X]    Print a sample line for every speech act.
 *   node src/cli.js learn --corpus f.jsonl ... Build a voice profile from real messages.
 *   node src/cli.js replay transcript.txt      Run a file of lead lines through the engine.
 *
 * `chat` is the fastest way to judge whether the voice sounds like him, which is
 * the only question that matters before the real corpus exists.
 */
import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createEngine } from './index.js';
import { createConsoleChannel } from './channels/console.js';
import { listVoiceProfiles, loadVoiceProfile } from './voice/profile.js';
import { createTemplateRealizer } from './voice/compose.js';
import { createBusinessProfile } from './domain/business.js';
import { createConversation, summarizeLead } from './domain/conversation.js';
import { SPEECH_ACTS } from './domain/planner.js';
import { loadCorpus, fromInstagramExport, buildProfileFromCorpus } from './voice/learn.js';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'chat';

const commands = { chat, voice, learn, replay, help };
await (commands[command] ?? help)();

// ---------------------------------------------------------------- commands --

async function chat() {
  const channel = createConsoleChannel({ label: dim('agent') });
  const engine = createEngine({
    logLevel: args.verbose ? 'debug' : 'silent',
    voiceProfile: args.profile,
    business: businessFromArgs(),
    realizer: args.llm ? 'llm' : 'template',
    respectQuietHours: false,
  });
  engine.addChannel(channel);
  await engine.start();

  const threadId = 'console:1';
  console.log(banner(engine));
  console.log(dim('Type as the lead. /slots /summary /plan /reset /quit\n'));

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: bold('lead: ') });
  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    if (text === '/quit' || text === '/exit') break;

    if (text.startsWith('/')) {
      await handleSlashCommand(text, engine, threadId);
      rl.prompt();
      continue;
    }

    const result = await engine.handle(channel.inbound(text, { threadId, senderName: args.name }));
    if (!result.outbound) {
      console.log(dim(`  (no reply sent: ${result.reason})`));
    } else if (args.debug) {
      console.log(dim(`  [${result.outbound.meta.speechActs.join(', ')}]`));
    }
    rl.prompt();
  }
  await engine.stop();
  console.log('\n' + dim('bye'));
}

async function handleSlashCommand(text, engine, threadId) {
  const convo = (await engine.store.get(threadId)) ?? createConversation({ threadId, channel: 'console' });

  if (text === '/slots') return console.log(JSON.stringify(convo.slots, null, 2));
  if (text === '/summary') return console.log(JSON.stringify(summarizeLead(convo), null, 2));
  if (text === '/plan') {
    const last = convo.turns.filter((t) => t.role === 'agent').at(-1);
    return console.log(dim(last ? `last acts: ${(last.speechActs ?? []).join(', ')}` : 'nothing sent yet'));
  }
  if (text === '/reset') {
    await engine.store.save(createConversation({ threadId, channel: 'console' }));
    return console.log(dim('conversation reset'));
  }
  if (text.startsWith('/preview ')) {
    const preview = await engine.preview(text.slice('/preview '.length), { threadId: `${threadId}:preview` });
    return console.log(JSON.stringify(preview, null, 2));
  }
  console.log(dim('commands: /slots /summary /plan /reset /preview <text> /quit'));
}

async function voice() {
  if (args.list || (!args.sample && !args.show)) {
    const profiles = listVoiceProfiles();
    console.log(bold('installed voice profiles:'));
    for (const id of profiles) {
      const p = loadVoiceProfile(id);
      const acts = Object.keys(p.phrases).length;
      const variants = Object.values(p.phrases).flat().length;
      console.log(
        `  ${id.padEnd(22)} ${p.displayName}\n${' '.repeat(24)}${dim(
          `${acts} acts, ${variants} variants, source: ${p.provenance.source}, samples: ${p.provenance.sampleCount}`,
        )}`,
      );
    }
    if (!args.sample) return;
  }

  const profile = loadVoiceProfile(args.profile ?? args.show ?? 'standard-locator');
  const business = businessFromArgs();
  const realizer = createTemplateRealizer({ profile, business });

  console.log(`\n${bold(`sample lines — ${profile.displayName}`)}\n`);
  for (const act of SPEECH_ACTS) {
    const convo = createConversation({ threadId: `sample:${act}`, channel: 'preview', contact: { id: 'x', name: 'Sam' } });
    convo.slots = {
      beds: 2,
      budget: { max: 2000 },
      areas: ['uptown'],
      moveIn: { iso: '2026-09-01' },
      tourAvailability: 'saturday afternoon',
    };
    const { parts } = await realizer.realize({
      plan: { steps: [{ act, data: { changed: ['beds', 'budget'], slots: convo.slots, when: 'saturday afternoon', multiple: 3 } }] },
      conversation: convo,
      seed: `sample:${act}`,
    });
    console.log(`  ${dim(act.padEnd(28))} ${parts.join('  ||  ') || dim('(no phrase)')}`);
  }
}

async function learn() {
  const id = args.id;
  const out = args.out;
  if ((!args.corpus && !args['ig-export']) || !id || !out) {
    console.error('usage: learn --corpus <file.jsonl> --id <profile-id> --out <path.json> [--base standard-locator]');
    console.error('   or: learn --ig-export <message_1.json> --me "Display Name" --id <id> --out <path.json>');
    process.exitCode = 1;
    return;
  }

  const corpus = args['ig-export']
    ? fromInstagramExport(args['ig-export'], args.me ?? '')
    : loadCorpus(args.corpus);

  if (!corpus.some((m) => m.role === 'agent')) {
    console.error('no agent messages found in the corpus. Check the format (see src/voice/corpus/README.md).');
    if (args['ig-export']) console.error('For an Instagram export, --me must exactly match his display name in the file.');
    process.exitCode = 1;
    return;
  }

  const base = args.base === 'none' ? null : loadVoiceProfile(args.base ?? 'standard-locator');
  const { profile, report } = buildProfileFromCorpus(corpus, {
    id,
    displayName: args.name,
    base,
    builtAt: new Date().toISOString(),
  });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(profile, null, 2) + '\n');

  console.log(bold(`\nbuilt voice profile "${id}" -> ${out}\n`));
  console.log(`  samples          ${report.sampleCount} agent messages`);
  console.log(`  confidence       ${report.confidence}`);
  console.log(`  style            ${report.style.casing}, ${Math.round(report.style.emojiRate * 100)}% emoji, ~${report.style.bubbles.targetWordsPerBubble} words/message`);
  console.log(`  tics             ${report.ticsFound.join(', ') || dim('none found')}`);
  console.log(`  learned acts     ${report.learnedActs.length ? report.learnedActs.join(', ') : dim('none')}`);
  if (report.thinActs.length) console.log(`  thin acts        ${dim(report.thinActs.join(', '))}`);
  if (report.actsUsingBaseline.length) {
    console.log(`  using baseline   ${dim(`${report.actsUsingBaseline.length} acts: ${report.actsUsingBaseline.join(', ')}`)}`);
  }
  console.log(`  exemplars        ${report.exemplarCount}`);
  for (const rec of report.recommendations) console.log(`\n  ${dim('note:')} ${rec}`);
  console.log(`\n  try it: VOICE_PROFILE=${id} npm run chat -- --profile ${out}\n`);
}

async function replay() {
  const file = args._[1];
  if (!file) {
    console.error('usage: replay <transcript.txt>   (one lead message per line)');
    process.exitCode = 1;
    return;
  }
  const channel = createConsoleChannel({ label: dim('agent') });
  const engine = createEngine({
    logLevel: 'silent',
    voiceProfile: args.profile,
    business: businessFromArgs(),
    respectQuietHours: false,
  });
  engine.addChannel(channel);

  const lines = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const threadId = `replay:${Date.now()}`;
  for (const line of lines) {
    console.log(bold(`lead: ${line}`));
    const result = await engine.handle(channel.inbound(line, { threadId }));
    if (!result.outbound) console.log(dim(`  (no reply: ${result.reason})`));
  }
  const convo = await engine.store.get(threadId);
  console.log('\n' + bold('lead summary:'));
  console.log(JSON.stringify(summarizeLead(convo), null, 2));
}

async function help() {
  console.log(`
${bold('leasing reply engine')}

  ${bold('chat')}                              talk to the engine as a lead
    --profile <id|path>               voice profile (default: standard-locator)
    --name <name>                     the lead's first name
    --llm                             use the model realizer (needs ANTHROPIC_API_KEY)
    --agent-name <name>               the agent the replies come from
    --debug                           print the speech acts behind each reply

  ${bold('voice')}                             inspect voices
    --list                            list installed profiles
    --sample [--profile <id>]         print a sample line for every speech act

  ${bold('learn')}                             build a profile from real messages
    --corpus <file.jsonl> --id <id> --out <path.json>
    --ig-export <message_1.json> --me "Display Name" --id <id> --out <path>
    --base <id|none>                  profile to fill gaps from (default: standard-locator)

  ${bold('replay')} <transcript.txt>            run a file of lead lines through the engine
`);
}

// ----------------------------------------------------------------- helpers --

function businessFromArgs() {
  return createBusinessProfile({
    agentName: args['agent-name'] ?? 'me',
    brand: args.brand,
  });
}

function banner(engine) {
  return [
    bold('leasing reply engine'),
    dim(`  voice: ${engine.profile.displayName} (${engine.profile.id})`),
    dim(`  realizer: ${engine.realizerName}   modules: ${engine.modules().length}   capabilities: ${engine.capabilities().join(', ') || 'none'}`),
  ].join('\n');
}

function parseArgs(argv) {
  /** @type {Record<string, any>} */
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
    } else {
      out._.push(arg);
    }
  }
  return out;
}

// Function declarations, not consts: the command dispatch above runs at module
// top level, before any const in this file is initialized.
function useColor() {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}
function dim(s) {
  return useColor() ? `\x1b[2m${s}\x1b[0m` : s;
}
function bold(s) {
  return useColor() ? `\x1b[1m${s}\x1b[0m` : s;
}
