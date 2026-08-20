/**
 * Structured logger. Deliberately tiny: the portal module will later subscribe
 * to the bus for anything it wants to display, so this only needs to be good
 * enough for a terminal and a log drain.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * @param {{level?: keyof typeof LEVELS, name?: string, sink?: (line: string) => void}} [opts]
 */
export function createLogger(opts = {}) {
  const level = LEVELS[opts.level ?? 'info'] ?? LEVELS.info;
  const name = opts.name ?? 'engine';
  const sink = opts.sink ?? ((line) => process.stdout.write(line + '\n'));

  /** @param {keyof typeof LEVELS} lvl */
  const at = (lvl) => (msg, fields = {}) => {
    if (LEVELS[lvl] < level) return;
    const payload = { ts: new Date().toISOString(), level: lvl, logger: name, msg, ...fields };
    sink(JSON.stringify(payload));
  };

  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    /** @param {string} child */
    child: (child) => createLogger({ ...opts, name: `${name}:${child}` }),
  };
}

export const nullLogger = createLogger({ level: 'silent' });
