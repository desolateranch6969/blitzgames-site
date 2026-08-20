/**
 * Module host: registration, dependency ordering, hooks, capabilities.
 *
 * The reply engine is itself just the first module plugged into this host. A
 * future scheduler, CRM sync, listing search, or management portal registers
 * the same way:
 *
 *   engine.use({
 *     name: 'tour-scheduler',
 *     version: '1.0.0',
 *     provides: ['tours.book', 'tours.availability'],
 *     requires: ['store'],
 *     setup(ctx) {
 *       ctx.bus.on('tour.requested', ...)
 *       ctx.provide('tours.book', async (req) => ...)
 *       return { hooks: { beforePlan: async (turn) => ... } }
 *     },
 *   })
 *
 * Capabilities are how the planner asks "can anyone actually do this yet?"
 * without knowing who. If nothing provides 'listings.search', the planner
 * promises to send a list by hand. The day a listings module registers, the
 * same conversation starts returning real units — no edit to the planner.
 */

/**
 * @typedef {Object} ModuleContext
 * @property {import('./bus.js').EVENTS} EVENTS
 * @property {ReturnType<import('./bus.js').createBus>} bus
 * @property {any} logger
 * @property {any} store
 * @property {Record<string, any>} config
 * @property {(name: string, impl: Function|object) => void} provide
 * @property {(name: string) => any} capability
 * @property {(name: string) => boolean} hasCapability
 *
 * @typedef {Object} EngineModule
 * @property {string} name
 * @property {string} [version]
 * @property {string[]} [provides]
 * @property {string[]} [requires]
 * @property {(ctx: ModuleContext) => ({hooks?: Record<string, Function>}|void|Promise<any>)} [setup]
 * @property {() => any} [teardown]
 */

/** Hook points, run in order during a turn. */
export const HOOKS = /** @type {const} */ ([
  'onInbound',      // raw message arrived, before anything is decided
  'beforeClassify',
  'afterClassify',
  'afterExtract',   // slots parsed and merged
  'beforePlan',
  'afterPlan',
  'beforeRealize',  // plan settled, text not yet written
  'afterRealize',   // text written, not yet checked
  'beforeSend',     // last chance to hold, edit, or reroute a reply
  'afterSend',
]);

export function createModuleHost({ bus, logger, store, config = {} }) {
  /** @type {Map<string, EngineModule>} */
  const modules = new Map();
  /** @type {Map<string, any>} */
  const capabilities = new Map();
  /** @type {Map<string, {module: string, fn: Function}[]>} */
  const hooks = new Map(HOOKS.map((h) => [h, []]));
  /** @type {EngineModule[]} */
  const pending = [];
  let started = false;

  function capability(name) {
    return capabilities.get(name);
  }
  function hasCapability(name) {
    return capabilities.has(name);
  }

  /** @param {EngineModule} mod */
  function use(mod) {
    if (!mod?.name) throw new Error('module requires a name');
    if (modules.has(mod.name)) throw new Error(`module "${mod.name}" already registered`);
    modules.set(mod.name, mod);
    pending.push(mod);
    if (started) {
      // Late registration is allowed; the portal will add modules at runtime.
      return setupModule(mod);
    }
    return undefined;
  }

  /** @param {EngineModule} mod */
  async function setupModule(mod) {
    const unmet = (mod.requires ?? []).filter((r) => !capabilities.has(r));
    if (unmet.length) {
      throw new Error(
        `module "${mod.name}" requires unavailable capabilities: ${unmet.join(', ')}. ` +
          `Register the providing module first.`,
      );
    }
    /** @type {ModuleContext} */
    const ctx = {
      bus,
      logger: logger.child(mod.name),
      store,
      config,
      EVENTS: bus.EVENTS,
      provide: (name, impl) => {
        if (capabilities.has(name)) {
          throw new Error(`capability "${name}" already provided by another module`);
        }
        capabilities.set(name, impl);
      },
      capability,
      hasCapability,
    };
    const result = (await mod.setup?.(ctx)) || {};
    for (const [point, fn] of Object.entries(result.hooks ?? {})) {
      if (!hooks.has(point)) throw new Error(`unknown hook "${point}" in module "${mod.name}"`);
      hooks.get(point).push({ module: mod.name, fn });
    }
    for (const declared of mod.provides ?? []) {
      if (!capabilities.has(declared)) {
        logger.warn('module declared a capability it never provided', {
          module: mod.name,
          capability: declared,
        });
      }
    }
    logger.debug('module ready', { module: mod.name, version: mod.version ?? '0.0.0' });
  }

  /** Resolve registration order so `requires` are satisfied before `setup`. */
  function order(list) {
    const remaining = [...list];
    const out = [];
    const satisfied = new Set(capabilities.keys());
    let guard = remaining.length + 1;
    while (remaining.length && guard-- > 0) {
      for (let i = 0; i < remaining.length; i++) {
        const mod = remaining[i];
        if ((mod.requires ?? []).every((r) => satisfied.has(r))) {
          out.push(mod);
          for (const p of mod.provides ?? []) satisfied.add(p);
          remaining.splice(i, 1);
          break;
        }
      }
    }
    // Anything left has a genuine cycle or missing dependency; setupModule
    // reports it with a useful message rather than silently dropping it.
    return [...out, ...remaining];
  }

  async function start() {
    for (const mod of order(pending)) await setupModule(mod);
    pending.length = 0;
    started = true;
  }

  async function stop() {
    for (const mod of [...modules.values()].reverse()) {
      try {
        await mod.teardown?.();
      } catch (err) {
        logger.error('module teardown failed', { module: mod.name, error: String(err) });
      }
    }
  }

  /**
   * Run a hook point. Hooks receive the mutable turn context; returning a value
   * is not required and is ignored, which keeps ordering side effects obvious.
   * @param {string} point
   * @param {any} turn
   */
  async function runHook(point, turn) {
    for (const { module, fn } of hooks.get(point) ?? []) {
      try {
        await fn(turn);
      } catch (err) {
        logger.error('hook failed', { hook: point, module, error: String(err?.stack ?? err) });
        await bus.emit(bus.EVENTS.ERROR, { source: `hook:${point}`, module, error: err });
      }
    }
  }

  return {
    use,
    start,
    stop,
    runHook,
    capability,
    hasCapability,
    provide: (name, impl) => capabilities.set(name, impl),
    list: () => [...modules.values()].map((m) => ({
      name: m.name,
      version: m.version ?? '0.0.0',
      provides: m.provides ?? [],
      requires: m.requires ?? [],
    })),
    capabilities: () => [...capabilities.keys()].sort(),
  };
}
