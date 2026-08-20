/**
 * Leasing reply engine — module 1.
 *
 * Public entry point. Everything else in this package is an implementation
 * detail of the turn pipeline below:
 *
 *   inbound -> screen -> classify -> extract slots -> plan -> realize
 *           -> guardrails -> pacing -> send -> persist -> emit
 *
 * Two properties are non-negotiable, because everything bolted on later depends
 * on them:
 *
 *   1. It runs standalone. No database, no API key, no platform credentials, no
 *      other module. `createEngine()` with zero arguments answers DMs.
 *   2. It never reaches out. It emits facts on a bus and asks a capability
 *      registry whether anyone can do a thing yet. A CRM, a scheduler, a listing
 *      search, or a management portal plugs into those two seams without this
 *      file changing.
 */
import { createBus, EVENTS } from './core/bus.js';
import { createModuleHost } from './core/module-host.js';
import { createLogger } from './core/logger.js';
import { createStoreFromConfig } from './store/index.js';
import { createClassifier } from './domain/intents.js';
import { extractSlots, mergeSlots } from './domain/slots.js';
import { createBusinessProfile } from './domain/business.js';
import { createConversation, isQualified, summarizeLead, STAGES } from './domain/conversation.js';
import { plan as planTurn } from './domain/planner.js';
import { loadVoiceProfile, createVoiceProfile } from './voice/profile.js';
import { createTemplateRealizer } from './voice/compose.js';
import { selectRealizer } from './generation/llm-realizer.js';
import { checkInbound, checkOutbound, withinQuietHours } from './policy/guardrails.js';
import { createRateLimiter, withinReplyWindow } from './policy/rate-limit.js';

export { EVENTS } from './core/bus.js';
export { createConversation, summarizeLead, STAGES } from './domain/conversation.js';
export { createBusinessProfile } from './domain/business.js';
export { createMarket } from './domain/market.js';
export { loadVoiceProfile, listVoiceProfiles, createVoiceProfile, mergeVoiceProfiles } from './voice/profile.js';
export { extractSlots } from './domain/slots.js';
export { createMemoryStore, createFileStore } from './store/index.js';

/**
 * @typedef {Object} EngineConfig
 * @property {string|import('./voice/profile.js').VoiceProfile} [voiceProfile]
 * @property {Partial<import('./domain/business.js').BusinessProfile>} [business]
 * @property {'template'|'llm'} [realizer]
 * @property {string} [anthropicApiKey]
 * @property {string} [llmModel]
 * @property {'memory'|'file'} [store]
 * @property {string} [storePath]
 * @property {any} [storeImpl]         Bring your own store implementation.
 * @property {boolean} [dryRun]        Compose replies, never deliver them.
 * @property {boolean} [autoSend]      false = always hand the reply back for approval.
 * @property {number} [maxMessagesPerThreadPerHour]
 * @property {'debug'|'info'|'warn'|'error'|'silent'} [logLevel]
 * @property {boolean} [respectQuietHours]
 * @property {boolean} [enforceReplyWindow]
 */

/**
 * @param {EngineConfig} [config]
 */
export function createEngine(config = {}) {
  const logger = createLogger({ level: config.logLevel ?? 'info', name: 'reply-engine' });
  const bus = createBus({ logger });
  const store = config.storeImpl ?? createStoreFromConfig(config);

  const business = createBusinessProfile(config.business ?? {});
  const profile =
    typeof config.voiceProfile === 'object' && config.voiceProfile
      ? createVoiceProfile(config.voiceProfile)
      : loadVoiceProfile(config.voiceProfile ?? process.env.VOICE_PROFILE ?? 'standard-locator');

  const classifier = createClassifier();
  const templateRealizer = createTemplateRealizer({ profile, business });
  const realizer = selectRealizer(config, { templateRealizer, profile, business, logger });

  const limiter = createRateLimiter({
    perThreadPerHour: config.maxMessagesPerThreadPerHour ?? 12,
  });

  const host = createModuleHost({ bus, logger, store, config });
  host.provide('store', store);
  host.provide('voice.profile', profile);
  host.provide('business.profile', business);

  /** @type {Map<string, any>} */
  const channels = new Map();
  let started = false;

  // ---------------------------------------------------------------- public --

  /** Register a bolt-on module. See core/module-host.js for the contract. */
  function use(mod) {
    return host.use(mod);
  }

  /**
   * Register a channel adapter (Instagram, console, or anything future).
   * @param {{name: string, send: Function, start?: Function, stop?: Function}} adapter
   */
  function addChannel(adapter) {
    if (!adapter?.name || typeof adapter.send !== 'function') {
      throw new Error('a channel adapter needs a name and a send(outbound) function');
    }
    channels.set(adapter.name, adapter);
    return adapter;
  }

  async function start() {
    if (started) return;
    await host.start();
    for (const adapter of channels.values()) {
      await adapter.start?.({ engine: api, bus, logger: logger.child(adapter.name) });
    }
    started = true;
    logger.info('engine started', {
      voice: profile.id,
      realizer: realizer.name,
      store: store.name ?? 'custom',
      modules: host.list().map((m) => m.name),
      capabilities: host.capabilities(),
    });
  }

  async function stop() {
    for (const adapter of channels.values()) await adapter.stop?.();
    await host.stop();
    started = false;
  }

  /**
   * Handle one inbound message end to end.
   *
   * @param {import('./core/types.js').InboundMessage} inbound
   * @returns {Promise<{
   *   sent: boolean,
   *   outbound: import('./core/types.js').OutboundMessage|null,
   *   conversation: import('./core/types.js').Conversation,
   *   reason?: string,
   *   violations?: any[],
   * }>}
   */
  async function handle(inbound) {
    if (!started) await start();

    // Webhook retries are normal, not exceptional. Replying twice to the same
    // message is the most visible way to look automated.
    if (await store.seen(inbound.id)) {
      logger.debug('duplicate message ignored', { id: inbound.id });
      const existing = (await store.get(inbound.threadId)) ?? createConversation(inbound);
      return { sent: false, outbound: null, conversation: existing, reason: 'duplicate' };
    }

    let conversation = (await store.get(inbound.threadId)) ?? createConversation({
      threadId: inbound.threadId,
      channel: inbound.channel,
      contact: { id: inbound.senderId, name: inbound.senderName, handle: inbound.senderHandle },
    });
    const isNew = conversation.turns.length === 0;

    conversation.turns.push({ role: 'lead', text: inbound.text, at: inbound.receivedAt ?? Date.now() });
    conversation.lastInboundAt = inbound.receivedAt ?? Date.now();

    /** @type {import('./core/types.js').TurnContext} */
    const turn = { inbound, conversation, notes: [], scratch: {} };

    await bus.emit(EVENTS.MESSAGE_RECEIVED, { inbound, conversation });
    if (isNew) await bus.emit(EVENTS.LEAD_CREATED, { conversation, summary: summarizeLead(conversation) });
    await host.runHook('onInbound', turn);

    // --- Screen: some messages must never get an automated answer. ---------
    const screen = checkInbound(inbound);
    if (!screen.allow) {
      if (screen.escalate) {
        conversation.status = 'awaiting_human';
        conversation.flags.escalationReason = screen.reason;
        await bus.emit(EVENTS.HUMAN_REQUESTED, {
          conversation,
          reason: screen.reason,
          summary: summarizeLead(conversation),
        });
      }
      await store.save(conversation);
      await bus.emit(EVENTS.MESSAGE_IGNORED, { inbound, reason: screen.reason });
      return { sent: false, outbound: null, conversation, reason: screen.reason };
    }

    // --- Understand -------------------------------------------------------
    await host.runHook('beforeClassify', turn);
    turn.classification = classifier.classify(inbound.text, { conversation });
    await host.runHook('afterClassify', turn);
    await bus.emit(EVENTS.MESSAGE_CLASSIFIED, { inbound, classification: turn.classification, conversation });

    const extracted = extractSlots(inbound.text, { market: business.market });
    const { slots, changed } = mergeSlots(conversation.slots, extracted);
    conversation.slots = slots;
    turn.scratch.changedSlots = changed;
    await host.runHook('afterExtract', turn);
    if (changed.length) {
      await bus.emit(EVENTS.SLOTS_UPDATED, { conversation, changed, slots });
    }

    const wasQualified = conversation.stage === STAGES.QUALIFIED || isQualifiedStage(conversation);

    // --- Decide -----------------------------------------------------------
    await host.runHook('beforePlan', turn);
    turn.plan = await planTurn(conversation, turn.classification, { changedSlots: changed }, {
      business,
      hasCapability: host.hasCapability,
      capability: host.capability,
    });
    await host.runHook('afterPlan', turn);
    await bus.emit(EVENTS.PLAN_READY, { conversation, plan: turn.plan });

    await emitDomainEvents(turn);

    if (turn.plan.handoff) {
      conversation.status = 'awaiting_human';
      await bus.emit(EVENTS.HUMAN_REQUESTED, {
        conversation,
        reason: turn.plan.note,
        summary: summarizeLead(conversation),
      });
    }

    if (!wasQualified && isQualified(conversation).ok) {
      await bus.emit(EVENTS.LEAD_QUALIFIED, { conversation, summary: summarizeLead(conversation) });
    }

    if (turn.plan.silent || turn.plan.steps.length === 0) {
      await store.save(conversation);
      await bus.emit(EVENTS.MESSAGE_IGNORED, { inbound, reason: turn.plan.note ?? 'nothing to say' });
      return { sent: false, outbound: null, conversation, reason: turn.plan.note ?? 'nothing to say' };
    }

    // --- Say it in his voice ---------------------------------------------
    await host.runHook('beforeRealize', turn);
    const realized = await realizer.realize({
      plan: turn.plan,
      conversation,
      seed: `${conversation.threadId}:${conversation.turns.length}:${profile.id}`,
    });
    turn.scratch.realized = realized;
    await host.runHook('afterRealize', turn);

    // --- Guardrails: the last gate before a lead sees anything. -----------
    let guard = checkOutbound(realized.parts, {
      profile,
      business,
      conversation,
      fragments: realized.fragments,
    });
    let parts = guard.parts;

    if (guard.blocked) {
      logger.warn('outbound blocked by guardrails', {
        threadId: conversation.threadId,
        rules: guard.violations.map((v) => v.rule),
      });
      conversation.status = 'awaiting_human';
      conversation.flags.lastBlock = guard.violations.map((v) => v.rule);
      await bus.emit(EVENTS.COMPLIANCE_FLAGGED, {
        conversation,
        violations: guard.violations,
        attempted: realized.parts,
      });
      await bus.emit(EVENTS.HUMAN_REQUESTED, {
        conversation,
        reason: 'guardrail block',
        summary: summarizeLead(conversation),
      });

      const safe = await safeHandoffReply(conversation);
      const safeGuard = checkOutbound(safe.parts, {
        profile,
        business,
        conversation,
        fragments: safe.fragments,
      });
      if (!safe.parts.length || safeGuard.blocked) {
        await store.save(conversation);
        return {
          sent: false,
          outbound: null,
          conversation,
          reason: 'blocked by guardrails',
          violations: guard.violations,
        };
      }
      parts = safeGuard.parts;
      realized.delaysMs = safe.delaysMs;
      turn.plan = { steps: [{ act: 'handoff.human' }], note: 'guardrail fallback', handoff: true };
      guard = safeGuard;
    }

    /** @type {import('./core/types.js').OutboundMessage} */
    const outbound = {
      threadId: conversation.threadId,
      channel: conversation.channel,
      parts,
      delaysMs: realized.delaysMs ?? parts.map(() => 0),
      meta: {
        speechActs: turn.plan.steps.map((s) => s.act),
        realizer: realized.realizer ?? realizer.name,
        voiceProfile: profile.id,
        plannerNote: turn.plan.note,
        requiresApproval: config.autoSend === false,
      },
    };
    turn.outbound = outbound;
    await bus.emit(EVENTS.REPLY_COMPOSED, { conversation, outbound, violations: guard.violations });

    // --- Pacing and platform limits --------------------------------------
    const hold = shouldHold(conversation);
    if (hold) {
      conversation.flags.heldReply = { at: Date.now(), reason: hold, parts };
      await store.save(conversation);
      await bus.emit(EVENTS.REPLY_HELD, { conversation, outbound, reason: hold });
      return { sent: false, outbound, conversation, reason: hold };
    }

    await host.runHook('beforeSend', turn);
    if (turn.scratch.cancelSend) {
      await store.save(conversation);
      await bus.emit(EVENTS.REPLY_HELD, { conversation, outbound, reason: 'cancelled by module' });
      return { sent: false, outbound, conversation, reason: 'cancelled by module' };
    }

    // --- Deliver ----------------------------------------------------------
    let sent = false;
    if (config.dryRun || config.autoSend === false) {
      logger.info('reply composed but not sent', {
        threadId: conversation.threadId,
        reason: config.dryRun ? 'dry run' : 'approval required',
      });
    } else {
      const adapter = channels.get(conversation.channel);
      if (adapter) {
        await adapter.send(outbound);
        sent = true;
      } else {
        logger.debug('no channel adapter registered; returning reply to caller', {
          channel: conversation.channel,
        });
      }
    }

    for (const part of parts) {
      conversation.turns.push({
        role: 'agent',
        text: part,
        at: Date.now(),
        speechActs: outbound.meta.speechActs,
      });
    }
    conversation.lastOutboundAt = Date.now();
    limiter.record(conversation.threadId);

    await store.save(conversation);
    await host.runHook('afterSend', turn);
    await bus.emit(EVENTS.REPLY_SENT, { conversation, outbound, sent });

    return { sent, outbound, conversation, violations: guard.violations };
  }

  // --------------------------------------------------------------- helpers --

  function isQualifiedStage(convo) {
    return [STAGES.QUALIFIED, STAGES.MATCHING, STAGES.TOURING, STAGES.APPLYING].includes(convo.stage);
  }

  /** @param {import('./core/types.js').TurnContext} turn */
  async function emitDomainEvents(turn) {
    const acts = new Set(turn.plan.steps.map((s) => s.act));
    const payload = { conversation: turn.conversation, summary: summarizeLead(turn.conversation) };

    if (acts.has('answer.tour.promise') || acts.has('answer.tour.options')) {
      await bus.emit(EVENTS.TOUR_REQUESTED, payload);
    }
    if (acts.has('answer.listings.promise') || acts.has('answer.listings.results')) {
      await bus.emit(EVENTS.LISTINGS_REQUESTED, payload);
    }
    if (acts.has('optout.ack')) {
      turn.conversation.status = 'opted_out';
      await bus.emit(EVENTS.OPTED_OUT, payload);
    }
    for (const act of acts) {
      if (act.startsWith('compliance.')) {
        await bus.emit(EVENTS.COMPLIANCE_FLAGGED, { ...payload, act, source: 'planner' });
      }
    }
  }

  /** A reply we can always fall back to when the composed one cannot be sent. */
  async function safeHandoffReply(conversation) {
    return templateRealizer.realize({
      plan: { steps: [{ act: 'handoff.human', data: { reason: 'guardrail' } }] },
      conversation,
      seed: `${conversation.threadId}:safe:${conversation.turns.length}`,
    });
  }

  /** @returns {string|null} reason to hold, or null to send */
  function shouldHold(conversation) {
    if (config.respectQuietHours !== false && withinQuietHours(business.hours)) {
      return 'quiet hours';
    }
    const rate = limiter.check(conversation.threadId);
    if (!rate.allowed) return rate.reason;

    if (config.enforceReplyWindow) {
      const window = withinReplyWindow(conversation);
      if (!window.ok) return window.reason;
    }
    return null;
  }

  // ------------------------------------------------------------------- api --

  const api = {
    handle,
    use,
    addChannel,
    start,
    stop,
    bus,
    store,
    logger,
    profile,
    business,
    classifier,
    realizerName: realizer.name,
    modules: () => host.list(),
    capabilities: () => host.capabilities(),
    provide: host.provide,
    hasCapability: host.hasCapability,
    /** Compose a reply without sending or persisting — for previews and tests. */
    async preview(text, { threadId = 'preview', name } = {}) {
      const convo = (await store.get(threadId)) ?? createConversation({ threadId, channel: 'preview', contact: { id: threadId, name } });
      const classification = classifier.classify(text, { conversation: convo });
      const { slots, changed } = mergeSlots(convo.slots, extractSlots(text, { market: business.market }));
      // Deep clone: planning records asks and the realizer records phrasings, and
      // a preview must never leave a mark on the real conversation.
      const preview = structuredClone({ ...convo, slots });
      const p = await planTurn(preview, classification, { changedSlots: changed }, {
        business,
        hasCapability: host.hasCapability,
        capability: host.capability,
      });
      const realized = await realizer.realize({ plan: p, conversation: preview, seed: `${threadId}:preview` });
      return { classification, slots, plan: p, parts: realized.parts };
    },
  };

  return api;
}

export default createEngine;
