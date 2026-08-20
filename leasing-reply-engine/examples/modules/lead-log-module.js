/**
 * Example bolt-on: lead capture.
 *
 * A CRM sync, a spreadsheet append, a webhook to another system — they are all
 * this shape. It subscribes to facts the engine emits and writes them somewhere.
 * The engine never knows it exists, so removing it cannot break a reply.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createLeadLogModule({ path = './data/leads.jsonl', onLead } = {}) {
  return {
    name: 'lead-log',
    version: '0.1.0',
    provides: ['leads.export'],

    setup(ctx) {
      const write = (event, summary) => {
        const record = { event, at: new Date().toISOString(), ...summary };
        if (onLead) return onLead(record);
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify(record) + '\n');
      };

      ctx.bus.on(ctx.EVENTS.LEAD_QUALIFIED, ({ summary }) => write('qualified', summary));
      ctx.bus.on(ctx.EVENTS.TOUR_REQUESTED, ({ summary }) => write('tour_requested', summary));
      ctx.bus.on(ctx.EVENTS.HUMAN_REQUESTED, ({ summary, reason }) => write('needs_human', { ...summary, reason }));
      ctx.bus.on(ctx.EVENTS.COMPLIANCE_FLAGGED, ({ summary, violations, act }) =>
        write('compliance', { ...summary, act, rules: (violations ?? []).map((v) => v.rule) }),
      );

      ctx.provide('leads.export', async (filter) => (await ctx.store.list(filter)).length);
    },
  };
}
