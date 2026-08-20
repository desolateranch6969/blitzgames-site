/**
 * Run the same conversation twice — once bare, once with a listings module
 * bolted on — to show what "operates independently, coordinates when extended"
 * actually means in output.
 *
 *   node examples/with-modules.js
 */
import { createEngine } from '../src/index.js';
import { createConsoleChannel } from '../src/channels/console.js';
import { createListingsModule } from './modules/listings-module.js';
import { createLeadLogModule } from './modules/lead-log-module.js';

const SCRIPT = [
  'hey! saw your page, looking for a 2 bed in uptown',
  'budget is around 2k, moving september 1st',
  'can you send me some options?',
];

async function run(label, { withModules }) {
  console.log(`\n=== ${label} ===`);
  const captured = [];
  const engine = createEngine({ logLevel: 'silent', respectQuietHours: false, business: { agentName: 'me' } });
  engine.addChannel(createConsoleChannel({ label: '  agent' }));

  if (withModules) {
    engine.use(createListingsModule());
    engine.use(createLeadLogModule({ onLead: (record) => captured.push(record) }));
  }
  await engine.start();

  const threadId = `demo:${label}`;
  for (const text of SCRIPT) {
    console.log(`  lead: ${text}`);
    await engine.handle({
      id: `${threadId}:${Math.random()}`,
      channel: 'console',
      threadId,
      senderId: 'demo-user',
      text,
      receivedAt: Date.now(),
    });
  }

  console.log(`  capabilities: ${engine.capabilities().join(', ') || 'none'}`);
  if (withModules) console.log(`  lead events captured: ${captured.map((c) => c.event).join(', ') || 'none'}`);
  await engine.stop();
}

await run('engine alone', { withModules: false });
await run('engine + listings + lead log', { withModules: true });
