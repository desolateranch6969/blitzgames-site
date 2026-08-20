/**
 * Instagram profile facts, via the official Business Discovery API.
 *
 * `business_discovery` returns public profile data for *professional* accounts
 * (business or creator) without any scraping: username, name, biography,
 * website, follower count, media count, and recent media. It is the sanctioned
 * endpoint and it covers a real share of inbound, because anyone running a small
 * business or building an audience has a professional account.
 *
 * For a personal account there is no API, and this provider returns an explicit
 * "not available" fact rather than nothing. That distinction matters in the
 * portal: "we looked and could not see" is different from "we never looked."
 */

/**
 * @param {{accountId?: string, pageAccessToken?: string, graphVersion?: string, fetchImpl?: typeof fetch}} [config]
 * @returns {import('../enricher.js').Provider}
 */
export function createInstagramPublicProvider(config = {}) {
  const {
    accountId = process.env.IG_ACCOUNT_ID,
    pageAccessToken = process.env.IG_PAGE_ACCESS_TOKEN,
    graphVersion = process.env.IG_GRAPH_VERSION || 'v21.0',
    fetchImpl = globalThis.fetch,
  } = config;

  return {
    name: 'instagram-public',
    host: 'graph.facebook.com',
    ttlMs: 7 * 24 * 3600_000,

    appliesTo(person) {
      return Boolean(accountId && pageAccessToken && handleOf(person));
    },

    async fetch(person) {
      const handle = handleOf(person);
      const url = new URL(`https://graph.facebook.com/${graphVersion}/${accountId}`);
      url.searchParams.set(
        'fields',
        `business_discovery.username(${handle}){username,name,biography,website,followers_count,follows_count,media_count}`,
      );

      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${pageAccessToken}` } });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Code 110 / "does not exist" is the documented answer for a personal
        // account, which is a finding, not an error.
        const message = body?.error?.message ?? `http ${response.status}`;
        if (/cannot be found|does not exist|not a business/i.test(message)) {
          return [
            {
              field: 'instagram.profile_visibility',
              value: 'personal_or_private',
              method: 'api',
              url: `https://instagram.com/${handle}`,
              confidence: 0.9,
            },
          ];
        }
        throw new Error(message);
      }

      const profile = body?.business_discovery;
      if (!profile) return [];

      const profileUrl = `https://instagram.com/${handle}`;
      return [
        fact('instagram.username', profile.username, profileUrl),
        fact('instagram.name', profile.name, profileUrl),
        fact('instagram.biography', profile.biography, profileUrl),
        fact('instagram.website', profile.website, profileUrl),
        fact('instagram.followers', profile.followers_count, profileUrl),
        fact('instagram.following', profile.follows_count, profileUrl),
        fact('instagram.posts', profile.media_count, profileUrl),
        fact('instagram.profile_visibility', 'professional', profileUrl),
      ].filter(Boolean);
    },
  };
}

function fact(field, value, url) {
  if (value == null || value === '') return null;
  return { field, value, method: 'api', url, confidence: 0.95 };
}

function handleOf(person) {
  return person.identifiers?.find((i) => i.kind === 'instagram_handle')?.value ?? null;
}
