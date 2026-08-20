/**
 * Model-backed realizer.
 *
 * Wraps the deterministic template realizer rather than replacing it: the
 * template output is the draft the model rewrites, and it is also the fallback
 * whenever the model is slow, unavailable, refuses, or returns something
 * unusable. The engine therefore has no hard dependency on a network call —
 * turning this on improves the prose, and turning it off costs nothing but
 * polish.
 *
 * Raw fetch is used on purpose: this module stays dependency-free so it can be
 * dropped into any runtime without a package tree.
 */
import { buildSystemPrompt, buildFewShot, buildTurnMessage, parseModelParts } from './prompt.js';
import { computeDelays } from '../voice/humanize.js';
import { createRng } from '../core/rng.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * @param {{
 *   profile: import('../voice/profile.js').VoiceProfile,
 *   business: import('../domain/business.js').BusinessProfile,
 *   fallback: {realize: Function, name: string},
 *   apiKey?: string,
 *   model?: string,
 *   maxTokens?: number,
 *   effort?: 'low'|'medium'|'high',
 *   timeoutMs?: number,
 *   serverSideFallback?: boolean,
 *   fetchImpl?: typeof fetch,
 *   logger?: any,
 * }} deps
 */
export function createLlmRealizer(deps) {
  const {
    profile,
    business,
    fallback,
    apiKey = process.env.ANTHROPIC_API_KEY,
    // Opus 5 is the default model. Override per deployment if a cheaper tier is
    // preferred for this volume of short rewrites — that is a cost decision for
    // the operator, not a default.
    model = process.env.LLM_MODEL || 'claude-opus-5',
    maxTokens = 700,
    effort = 'low',
    timeoutMs = 8000,
    serverSideFallback = true,
    fetchImpl = globalThis.fetch,
    logger,
  } = deps;

  const systemPrompt = buildSystemPrompt(profile, business);
  const fewShot = buildFewShot(profile);

  return {
    name: 'llm',
    profileId: profile.id,
    model,

    /**
     * @param {{plan: any, conversation: any, seed?: string}} input
     */
    async realize(input) {
      const drafted = await fallback.realize(input);
      if (!drafted.parts.length) return drafted;
      if (!apiKey) {
        logger?.debug('no ANTHROPIC_API_KEY set; using template realizer');
        return drafted;
      }

      try {
        const parts = await rewrite(drafted.parts, input);
        if (!parts) return drafted;

        const rng = createRng(input.seed ?? `${input.conversation.threadId}:llm`);
        return {
          parts,
          delaysMs: computeDelays(parts, profile.style, rng),
          fragments: parts.map((text, i) => ({ act: drafted.fragments[i]?.act ?? 'llm', text })),
          realizer: 'llm',
        };
      } catch (err) {
        logger?.warn('llm realizer failed; falling back to template', { error: String(err?.message ?? err) });
        return drafted;
      }
    },
  };

  /**
   * @param {string[]} draft
   * @param {{plan: any, conversation: any}} input
   */
  async function rewrite(draft, input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    /** @type {Record<string, string>} */
    const headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    };

    /** @type {Record<string, any>} */
    const body = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        ...fewShot,
        { role: 'user', content: buildTurnMessage({ conversation: input.conversation, plan: input.plan, draft }) },
      ],
      // Effort, not temperature: sampling parameters are rejected on current
      // models, and a short rewrite does not need deep reasoning.
      output_config: { effort },
    };

    // Server-side refusal fallback: if a safety classifier declines the rewrite,
    // the platform routes it rather than handing back an unusable turn. The
    // template draft still backstops everything.
    if (serverSideFallback) {
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      body.fallbacks = 'default';
    }

    try {
      const response = await fetchImpl(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`anthropic api ${response.status}: ${detail.slice(0, 300)}`);
      }

      const payload = await response.json();

      // Always check stop_reason before reading content.
      if (payload.stop_reason === 'refusal') {
        logger?.warn('model refused the rewrite; using template draft', {
          category: payload.stop_details?.category ?? null,
        });
        return null;
      }

      const text = (payload.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      const parts = parseModelParts(text);
      if (!parts) return null;

      // The model rewrites; it does not get to change how many bubbles are sent.
      return parts.slice(0, profile.style.bubbles.maxBubbles ?? 3);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pick a realizer from configuration. Unknown values fall back to the template
 * backend rather than throwing — a typo in an env var must not silence the
 * inbox.
 * @param {{realizer?: string} & Record<string, any>} config
 */
export function selectRealizer(config, { templateRealizer, profile, business, logger }) {
  if (config.realizer === 'llm') {
    return createLlmRealizer({
      profile,
      business,
      fallback: templateRealizer,
      apiKey: config.anthropicApiKey,
      model: config.llmModel,
      logger,
    });
  }
  if (config.realizer && config.realizer !== 'template') {
    logger?.warn('unknown realizer requested; using template', { requested: config.realizer });
  }
  return templateRealizer;
}
