/**
 * Personal site / link-in-bio provider.
 *
 * When someone puts a URL in their Instagram bio they are publishing it, and
 * fetching one page is the least invasive enrichment there is. It is often the
 * highest-value one too: a link-in-bio commonly leads straight to a LinkedIn, a
 * company page, or a booking profile, which is what actually identifies the
 * person.
 *
 * Politeness is not optional here — robots.txt is honored, one page is fetched,
 * redirects are capped, and the body is size-limited. A crawler that ignores
 * these gets the server's IP blocked and produces nothing.
 */
import { normalizeLinkedInUrl } from '../../identity/handles.js';

/**
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number, userAgent?: string}} [config]
 * @returns {import('../enricher.js').Provider}
 */
export function createWebsiteProvider(config = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    maxBytes = 512 * 1024,
    userAgent = 'leasing-lead-ingestor/0.1 (+contact: set CONTACT_URL)',
  } = config;

  return {
    name: 'website',
    ttlMs: 30 * 24 * 3600_000,

    appliesTo(person) {
      return Boolean(websiteOf(person));
    },

    async fetch(person) {
      const target = websiteOf(person);
      const url = new URL(target);

      if (!(await robotsAllows(url, { fetchImpl, userAgent, timeoutMs }))) {
        return [
          { field: 'website.fetched', value: false, method: 'inferred', url: target, confidence: 1,
            // Recorded so the portal can show why nothing came back.
          },
        ];
      }

      const html = await fetchText(target, { fetchImpl, timeoutMs, maxBytes, userAgent });
      if (!html) return [];

      const facts = [
        text('website.title', firstMatch(html, /<title[^>]*>([\s\S]{1,200}?)<\/title>/i), target),
        text('website.description', attr(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']{1,300})["']/i), target),
        text('website.og_title', attr(html, /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']{1,200})["']/i), target),
      ].filter(Boolean);

      // Outbound social links are the useful part: they are how a person's
      // profiles get connected without guessing.
      const links = [...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
      const linkedin = links.map(normalizeLinkedInUrl).find(Boolean);
      if (linkedin) {
        facts.push({
          field: 'linkedin.url',
          value: linkedin,
          method: 'public_page',
          url: target,
          confidence: 0.8,
        });
      }

      return facts;
    },
  };
}

function websiteOf(person) {
  const identifier = person.identifiers?.find((i) => i.kind === 'website')?.value;
  if (identifier) return identifier;
  const fact = person.facts?.find((f) => f.field === 'instagram.website')?.value;
  return typeof fact === 'string' && /^https?:\/\//.test(fact) ? fact : null;
}

async function robotsAllows(url, { fetchImpl, userAgent, timeoutMs }) {
  try {
    const robots = await fetchText(`${url.protocol}//${url.hostname}/robots.txt`, {
      fetchImpl,
      timeoutMs,
      maxBytes: 64 * 1024,
      userAgent,
    });
    if (!robots) return true;

    // Only the wildcard group is consulted; a rule aimed at a named crawler is
    // not aimed at us, and a disallow of "/" means stay out entirely.
    const wildcard = robots.split(/user-agent:/i).find((block) => /^\s*\*/.test(block)) ?? '';
    const disallows = [...wildcard.matchAll(/disallow:\s*(\S*)/gi)].map((m) => m[1]);
    return !disallows.some((rule) => rule === '/' || (rule && url.pathname.startsWith(rule)));
  } catch {
    return true;
  }
}

async function fetchText(target, { fetchImpl, timeoutMs, maxBytes, userAgent }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': userAgent, accept: 'text/html,text/plain' },
    });
    if (!response.ok) return null;
    const type = response.headers?.get?.('content-type') ?? '';
    if (type && !/text\/html|text\/plain/.test(type)) return null;
    const body = await response.text();
    return body.slice(0, maxBytes);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function firstMatch(html, re) {
  return html.match(re)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
}
function attr(html, re) {
  return html.match(re)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
}
function text(field, value, url) {
  return value ? { field, value, method: 'public_page', url, confidence: 0.85 } : null;
}
