/**
 * Title normalization.
 *
 * CRM exports and crawled staff pages spell the same job a dozen ways: "Asst.
 * Mgr", "Assistant Property Manager", "APM", "Assistant Community Manager".
 * Everything downstream — who to contact, who to escalate to, who is even a
 * person versus a shared office inbox — depends on collapsing those onto one
 * set of roles.
 *
 * The ladder is deliberately short. Six rungs cover who actually answers a
 * locator's call; a taxonomy with thirty roles looks thorough and then produces
 * confident nonsense on the first unusual title.
 *
 * **Unrecognized titles stay unrecognized.** They keep their raw text, get role
 * `unknown` and level `null`, and surface in a review list. A wrong level is
 * worse than a missing one: it silently reorders who gets contacted first.
 */

/**
 * Level is authority rank, low number = higher authority. It orders contacts
 * within a property and drives "who is above this person".
 */
export const ROLES = {
  corporate:         { level: 0, label: 'Corporate',          person: true },
  regional:          { level: 1, label: 'Regional',           person: true },
  manager:           { level: 2, label: 'Property manager',   person: true },
  assistant_manager: { level: 3, label: 'Assistant manager',  person: true },
  leasing:           { level: 4, label: 'Leasing',            person: true },
  office:            { level: 4, label: 'Leasing office',     person: false },
  maintenance:       { level: 6, label: 'Maintenance',        person: true },
  unknown:           { level: null, label: 'Unknown',         person: true },
};

/**
 * Ordered most specific first — "assistant property manager" must not match the
 * "property manager" rule. Order is the whole correctness story here.
 * @type {{role: keyof typeof ROLES, re: RegExp}[]}
 */
const PATTERNS = [
  // A shared office identity rather than a person.
  { role: 'office', re: /\b(leasing office|main office|front office|office line|general inquiries|info|contact us|rentals?|leasing team|the office)\b/ },

  { role: 'assistant_manager', re: /\b(assistant|asst\.?|assoc\.?|associate|deputy)\s*(property|community|business|general)?\s*(manager|mgr|mngr)\b|^\s*a\.?\s?[pc]\.?\s?m\.?\s*$|^\s*apm\s*$/ },

  { role: 'regional', re: /\b(regional|area|district|portfolio|multi[- ]?site)\s*(vice president|vp|director|manager|mgr|supervisor)?\b|\brvp\b/ },

  { role: 'corporate', re: /\b(owner|principal|founder|president|vice president|vp|c[eo]o|cfo|chief|asset manager|director of (leasing|operations|property management)|head of)\b/ },

  { role: 'leasing', re: /\b(leasing)\s*(manager|mgr|consultant|agent|professional|specialist|associate|coordinator|director|advisor)?\b|\b(sales|lease up|lease-up)\s*(consultant|agent|specialist)\b|\bconcierge\b/ },

  { role: 'manager', re: /\b(property|community|business|general|site|resident)\s*(manager|mgr|mngr|director)\b|^\s*[pcgb]\.?\s?m\.?\s*$|\bmanager\b/ },

  { role: 'maintenance', re: /\b(maintenance|service|facilities|groundskeep|porter|technician|tech|engineer|make ?ready)\b/ },
];

/**
 * @param {string} rawTitle
 * @returns {{role: keyof typeof ROLES, level: number|null, label: string, confident: boolean, raw: string}}
 */
export function normalizeTitle(rawTitle) {
  const raw = String(rawTitle ?? '').trim();
  const text = raw
    .toLowerCase()
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return { role: 'unknown', level: null, label: ROLES.unknown.label, confident: false, raw };

  for (const { role, re } of PATTERNS) {
    if (re.test(text)) {
      return { role, level: ROLES[role].level, label: ROLES[role].label, confident: true, raw };
    }
  }
  return { role: 'unknown', level: null, label: ROLES.unknown.label, confident: false, raw };
}

/**
 * Is this contact record a person, or the office itself?
 *
 * It matters for messaging: you can text a leasing agent and expect a person;
 * the office inbox is a queue. It also matters for the directory's other job —
 * an office line should never be treated as an individual to build a profile of.
 *
 * @param {{role?: string, displayName?: string, channels?: {kind: string, value: string}[]}} contact
 */
export function isOffice(contact) {
  if (contact?.role === 'office') return true;
  const name = String(contact?.displayName ?? '').toLowerCase();
  if (/\b(office|leasing|rentals?|info|contact|team|management)\b/.test(name) && !/\s/.test(name.trim())) return true;
  return (contact?.channels ?? []).some((c) => c.kind === 'email' && /^(info|leasing|rentals?|office|hello|contact)@/.test(c.value));
}

/**
 * Who a locator actually wants on screen: the office, and the manager.
 *
 * Everything else stays in the record and is one click away. This is the
 * function the default view calls — the ladder exists for ordering and
 * escalation, not for display.
 *
 * @param {{role: string, level: number|null, status?: string}[]} contacts
 */
export function frontDesk(contacts) {
  const live = (contacts ?? []).filter((c) => c.status !== 'departed');
  const office = live.find((c) => c.role === 'office') ?? null;

  // Whoever has the most authority among the actual people on file. Showing
  // "not on file" while two contacts sit in the record is worse than showing
  // the regional and letting the label say so.
  const manager = byAuthority(live.filter((c) => c.role !== 'office'))[0] ?? null;

  return { office, manager, otherCount: Math.max(0, live.length - [office, manager].filter(Boolean).length) };
}

/**
 * Order contacts the way a person would work down a list: authority first,
 * unknown titles last rather than first.
 * @param {{level: number|null}[]} contacts
 */
export function byAuthority(contacts) {
  return [...(contacts ?? [])].sort((a, b) => {
    const al = a.level ?? 99;
    const bl = b.level ?? 99;
    return al - bl;
  });
}

/**
 * The people above a given contact, nearest first — for when the leasing agent
 * stops answering. Contacts at the property come first, then the same ladder at
 * each ancestor node, which the caller supplies.
 *
 * @param {{level: number|null}} contact
 * @param {{level: number|null}[]} atProperty
 * @param {{level: number|null}[]} [above]  Contacts at parent nodes, already collected.
 */
export function chainAbove(contact, atProperty, above = []) {
  const level = contact?.level ?? 99;
  const higherAtProperty = byAuthority(atProperty).filter((c) => (c.level ?? 99) < level && c !== contact);
  return [...higherAtProperty, ...byAuthority(above)];
}
