/**
 * Device bridge: a dedicated phone wired to the Mac, driven and polled.
 *
 * ## Why this exists
 *
 * Not preference — coverage. The Graph API only sees DMs to a professional
 * account, only inside its retention window, and never sees message requests
 * sitting in the hidden-requests folder, which is exactly where a cold inbound
 * lead from a stranger lands. A device sees the inbox the way he sees it.
 *
 * ## What it costs
 *
 * Be clear-eyed: automating the app is against Instagram's terms, and the
 * account carries the risk, not the server. Meta detects automation primarily
 * through behavioral rhythm — poll cadence that never varies, taps at identical
 * coordinates, activity at 4am, reading faster than a human can scroll. The
 * pacing controls below are not politeness, they are the difference between a
 * rig that runs for months and one that gets the account restricted in a week.
 * Treat it as the fallback for what the API cannot reach, keep the API as the
 * primary path, and never point it at his main personal account.
 *
 * ## The rig, on a Mac
 *
 * Android over `adb` is the practical choice. iOS automation needs Xcode plus a
 * WebDriverAgent build that has to be re-signed roughly weekly, which is a lot
 * of maintenance for the same result.
 *
 *   brew install android-platform-tools
 *   # phone: Settings > About > tap Build number 7x > Developer options > USB debugging
 *   adb devices                     # confirm it is listed as "device", not "unauthorized"
 *   adb shell dumpsys battery set level 100   # keep it awake and charged on a powered hub
 *
 * Read paths, in increasing order of fragility:
 *   1. Notification listener — `adb shell dumpsys notification --noredact` gives
 *      sender and preview text without opening the app at all. Lowest risk, and
 *      enough to know a DM arrived and who from.
 *   2. UI dump — `adb exec-out uiautomator dump /dev/tty` while the inbox is
 *      open. Full text, but selectors break on every app update.
 *   3. Screenshot + OCR — `adb exec-out screencap -p` piped to Vision.framework
 *      via a small Swift shim. Survives layout changes, costs latency.
 *
 * This file implements the contract, the pacing, and the adb plumbing. The
 * screen-scraping selectors are deliberately left as a driver interface: they
 * are version-specific, they change without notice, and hardcoding today's
 * resource-ids into the architecture would be the least durable thing here.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeRawEvent } from './source.js';

const run = promisify(execFile);

/**
 * @typedef {Object} DeviceDriver
 * @property {string} name
 * @property {() => Promise<{ok: boolean, detail?: string}>} probe
 * @property {() => Promise<DeviceMessage[]>} readInbox
 * @property {(threadKey: string, text: string) => Promise<void>} [sendMessage]
 *
 * @typedef {Object} DeviceMessage
 * @property {string} threadKey     Whatever the driver can key a thread on.
 * @property {string} [handle]
 * @property {string} [displayName]
 * @property {string} text
 * @property {number} [at]
 * @property {'inbox'|'request'} [folder]
 */

/**
 * Human-shaped pacing.
 *
 * A fixed interval is the clearest automation tell there is, so the interval is
 * jittered, the rig sleeps overnight, and it takes irregular longer breaks. The
 * defaults are conservative on purpose.
 *
 * @param {{minMs?: number, maxMs?: number, quietStart?: number, quietEnd?: number,
 *          breakChance?: number, breakMs?: number, now?: () => number}} [opts]
 */
export function createPacer(opts = {}) {
  const {
    minMs = 90_000,
    maxMs = 420_000,
    quietStart = 23,
    quietEnd = 7,
    breakChance = 0.12,
    breakMs = 45 * 60_000,
    now = () => Date.now(),
  } = opts;

  return {
    /** Milliseconds to wait before the next poll. */
    nextDelay(random = Math.random) {
      const hour = new Date(now()).getHours();
      const asleep = quietStart > quietEnd ? hour >= quietStart || hour < quietEnd : hour >= quietStart && hour < quietEnd;
      if (asleep) {
        const wakeHour = quietEnd;
        const wake = new Date(now());
        wake.setHours(wakeHour, Math.floor(random() * 40), 0, 0);
        if (wake.getTime() <= now()) wake.setDate(wake.getDate() + 1);
        return wake.getTime() - now();
      }
      if (random() < breakChance) return breakMs + random() * breakMs;
      return minMs + random() * (maxMs - minMs);
    },
    isQuietHours() {
      const hour = new Date(now()).getHours();
      return quietStart > quietEnd ? hour >= quietStart || hour < quietEnd : hour >= quietStart && hour < quietEnd;
    },
  };
}

/**
 * The adb transport. Everything device-specific funnels through here so a
 * different driver (iOS, an emulator, a second phone) only has to reimplement
 * `DeviceDriver`.
 *
 * @param {{serial?: string, adbPath?: string, execImpl?: Function}} [config]
 */
export function createAdb(config = {}) {
  const adbPath = config.adbPath ?? process.env.ADB_PATH ?? 'adb';
  const exec = config.execImpl ?? run;
  const base = config.serial ? ['-s', config.serial] : [];

  return {
    /** @param {string[]} args */
    async raw(args, opts = {}) {
      const { stdout } = await exec(adbPath, [...base, ...args], {
        maxBuffer: 16 * 1024 * 1024,
        encoding: opts.encoding ?? 'utf8',
        timeout: opts.timeoutMs ?? 20_000,
      });
      return stdout;
    },

    async devices() {
      const out = await exec(adbPath, ['devices'], { timeout: 10_000 });
      return String(out.stdout)
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter(([serial, state]) => serial && state)
        .map(([serial, state]) => ({ serial, state }));
    },

    /** Notifications: the lowest-risk read, since the app is never opened. */
    async notifications() {
      return this.raw(['shell', 'dumpsys', 'notification', '--noredact']);
    },

    /** A UI dump of whatever is on screen. */
    async uiDump() {
      return this.raw(['exec-out', 'uiautomator', 'dump', '/dev/tty']);
    },

    async screenshot() {
      return this.raw(['exec-out', 'screencap', '-p'], { encoding: 'buffer', timeoutMs: 30_000 });
    },

    async isScreenOn() {
      const out = await this.raw(['shell', 'dumpsys', 'power']);
      return /mWakefulness=Awake/.test(out);
    },
  };
}

/**
 * Parse Instagram entries out of a notification dump.
 *
 * This is the one screen-read implemented here, because notification records are
 * far more stable across app versions than any view hierarchy. It yields sender
 * and preview text — enough to create a lead and triage it; the full thread is
 * fetched later by whatever path is available.
 *
 * @param {string} dump
 * @returns {DeviceMessage[]}
 */
export function parseNotificationDump(dump) {
  /** @type {DeviceMessage[]} */
  const messages = [];
  const blocks = String(dump).split(/NotificationRecord\(/).slice(1);

  for (const block of blocks) {
    if (!/pkg=com\.instagram\.android/.test(block)) continue;
    const title = block.match(/android\.title=String \((.+?)\)/)?.[1];
    const text = block.match(/android\.text=String \((.+?)\)/)?.[1];
    if (!title || !text) continue;
    // Group and non-message notifications ("liked your photo") are not leads.
    if (/liked|started following|mentioned you in a comment|added to their story/i.test(text)) continue;

    messages.push({
      threadKey: `notif:${title.trim().toLowerCase()}`,
      displayName: title.trim(),
      handle: /^[a-z0-9._]+$/i.test(title.trim()) ? title.trim().toLowerCase() : undefined,
      text: text.trim(),
      at: Number(block.match(/when=(\d{10,})/)?.[1]) || Date.now(),
      folder: /message request/i.test(block) ? 'request' : 'inbox',
    });
  }
  return messages;
}

/**
 * A driver built on notification reads. Good enough to detect and triage a new
 * inbound; it does not read history.
 * @param {{adb: ReturnType<typeof createAdb>}} deps
 * @returns {DeviceDriver}
 */
export function createNotificationDriver({ adb }) {
  return {
    name: 'adb-notifications',
    async probe() {
      const devices = await adb.devices().catch((err) => {
        throw new Error(`adb not reachable: ${err.message}. Is android-platform-tools installed?`);
      });
      const ready = devices.filter((d) => d.state === 'device');
      if (!ready.length) {
        const unauthorized = devices.some((d) => d.state === 'unauthorized');
        return {
          ok: false,
          detail: unauthorized
            ? 'device is connected but unauthorized — accept the USB debugging prompt on the phone'
            : 'no device connected',
        };
      }
      return { ok: true, detail: `${ready.length} device(s): ${ready.map((d) => d.serial).join(', ')}` };
    },
    async readInbox() {
      return parseNotificationDump(await adb.notifications());
    },
  };
}

/**
 * @param {{
 *   driver: DeviceDriver, pacer?: ReturnType<typeof createPacer>,
 *   accountLabel?: string, logger?: any,
 * }} config
 * @returns {import('./source.js').Source & {nextDelay: () => number}}
 */
export function createDeviceSource(config) {
  const { driver, pacer = createPacer(), accountLabel = 'device', logger } = config;
  /** @type {Set<string>} */
  const seen = new Set();
  let lastEventAt = null;
  let lastPolledAt = null;

  return {
    name: 'device',
    mode: 'pull',
    nextDelay: () => pacer.nextDelay(),

    async poll() {
      if (pacer.isQuietHours()) {
        logger?.debug?.('device source asleep');
        return [];
      }
      lastPolledAt = new Date().toISOString();

      const messages = await driver.readInbox();
      /** @type {import('../core/types.js').RawEvent[]} */
      const events = [];

      for (const message of messages) {
        // A notification dump repeats until dismissed, so dedupe is mandatory
        // rather than defensive.
        const key = `${message.threadKey}:${message.at}:${hash(message.text)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        events.push(
          makeRawEvent({
            source: 'device',
            kind: 'message',
            platform: 'instagram',
            platformId: message.threadKey,
            handle: message.handle,
            displayName: message.displayName,
            id: `device:${key}`,
            threadId: `ig-device:${message.threadKey}`,
            text: message.text,
            occurredAt: message.at,
            payload: {
              folder: message.folder ?? 'inbox',
              driver: driver.name,
              account: accountLabel,
              // Device reads are previews, not authoritative thread state.
              partial: true,
            },
          }),
        );
      }

      if (seen.size > 5000) for (const key of [...seen].slice(0, 1000)) seen.delete(key);
      if (events.length) lastEventAt = events.at(-1).occurredAt;
      return events;
    },

    async health() {
      const probe = await driver.probe().catch((err) => ({ ok: false, detail: String(err.message) }));
      return {
        status: probe.ok ? (pacer.isQuietHours() ? 'degraded' : 'ok') : 'down',
        detail: probe.ok && pacer.isQuietHours() ? `${probe.detail} (quiet hours)` : probe.detail,
        lastEventAt,
        lastPolledAt,
      };
    },
  };
}

function hash(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(text).length; i++) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(36);
}
