/**
 * Console channel: the same adapter contract as Instagram, backed by stdout.
 *
 * Useful for three things — the interactive `npm run chat` simulator, replaying
 * a transcript to see how the voice reads, and any test that wants to assert on
 * what would have been sent without touching a network.
 */

/**
 * @param {{write?: (line: string) => void, respectDelays?: boolean, label?: string}} [options]
 */
export function createConsoleChannel(options = {}) {
  const write = options.write ?? ((line) => process.stdout.write(line + '\n'));
  const label = options.label ?? 'agent';
  /** @type {import('../core/types.js').OutboundMessage[]} */
  const sent = [];

  return {
    name: 'console',
    sent,

    async send(outbound) {
      sent.push(outbound);
      for (const [index, part] of outbound.parts.entries()) {
        if (options.respectDelays && index > 0) {
          await new Promise((r) => setTimeout(r, Math.min(outbound.delaysMs?.[index] ?? 0, 2500)));
        }
        write(`${label}: ${part}`);
      }
      return { sentIds: outbound.parts.map((_, i) => `console-${sent.length}-${i}`) };
    },

    /** Build an inbound message from a typed line. */
    inbound(text, { threadId = 'console:1', senderId = 'console-user', senderName } = {}) {
      return {
        id: `console-${Date.now()}-${Math.round(performance.now() * 1000)}`,
        channel: 'console',
        threadId,
        senderId,
        senderName,
        text,
        receivedAt: Date.now(),
      };
    },
  };
}
