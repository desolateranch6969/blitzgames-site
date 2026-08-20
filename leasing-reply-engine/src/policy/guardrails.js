/**
 * Outbound guardrails.
 *
 * The planner already routes compliance-sensitive questions to neutral answers,
 * but a realizer — especially a model-backed one — can still produce text that
 * a leasing professional must not send. This is the last gate before anything
 * reaches a lead, and it runs on the finished words regardless of which backend
 * wrote them.
 *
 * Two categories:
 *
 *   BLOCK  - the message cannot be sent as written. The engine falls back to a
 *            safe reply and flags the thread for a human.
 *   WARN   - the message goes out, but the event carries the note so the future
 *            portal can surface a pattern.
 *
 * Fair housing is not a style preference. Describing an area or its residents,
 * commenting on children, or steering by any protected class is a legal problem
 * for the broker, not an awkward sentence. Automation makes it worse by doing it
 * at volume, so this file errs hard toward blocking.
 */

/**
 * Steering rules.
 *
 * Patterns, not a phrase list. "safe area" and "that area is really safe" are
 * the same violation, and a fixed list of strings catches only the first. Each
 * rule pairs a subject (an area, a building, the people in it) with a judgment
 * the agent is not permitted to make.
 *
 * @type {{rule: string, re: RegExp, detail: string}[]}
 */
export const STEERING_RULES = [
  {
    rule: 'fair_housing.area_character',
    re: /\b(area|neighborhood|neighbourhood|part of town|side of town|block|building|complex|community|property|street)\b[^.?!]{0,40}\b(is|are|isnt|is not|feels?|seems?|stays?|very|really|pretty|super|totally)?\s*(safe|unsafe|dangerous|sketchy|shady|rough|ghetto|bad|nice|good|great|clean|quiet|scary|awesome|amazing|lovely|decent|desirable|upscale|up and coming|transitional|gentrifying|trendy)\b/,
    detail: 'characterizes an area or building',
  },
  {
    rule: 'fair_housing.area_character',
    re: /\b(safe|unsafe|dangerous|sketchy|shady|rough|ghetto|bad|nice|good|great|clean|quiet|scary|awesome|amazing|lovely|decent|desirable|upscale|up and coming|transitional|gentrifying|trendy)\s+(area|neighborhood|neighbourhood|part of town|side of town|block|building|complex|community)\b/,
    detail: 'characterizes an area or building',
  },
  {
    rule: 'fair_housing.crime',
    re: /\b(crime rate|high crime|low crime|crime free|crime is|lot of crime|no crime|break ?ins|shootings)\b/,
    detail: 'comments on crime',
  },
  {
    rule: 'fair_housing.schools',
    re: /\bschools?\b[^.?!]{0,30}\b(good|great|bad|best|top|highly rated|excellent|terrible|poor)\b|\b(good|great|bad|best|top|highly rated|excellent|terrible|poor)\b[^.?!]{0,20}\bschools?\b|\bschool district\b/,
    detail: 'comments on schools, a familial-status proxy',
  },
  {
    rule: 'fair_housing.familial_status',
    re: /\b(family friendly|kid friendly|child friendly|(good|great|perfect|ideal|nice|better) for (kids|families|children)|no kids|no children|adults only|child ?free|not for (kids|children|families))\b|\b(area|neighborhood|neighbourhood|building|complex|community|place|spot|property|street|block)\b[^.?!]{0,30}\bfor (families|kids|children)\b/,
    detail: 'sorts housing by whether children are present',
  },
  {
    rule: 'fair_housing.demographics',
    re: /\b(what (kind|type|sort) of people|who lives (there|here|in that)|the people (there|here|in that)|demographics?|mostly (white|black|hispanic|latino|asian|indian|arab|jewish|muslim|christian|young|old|older|students?|professionals?|families|singles|couples|retirees)|is it diverse|racial|ethnicity)\b/,
    detail: 'describes who lives somewhere',
  },
  {
    rule: 'fair_housing.crowd',
    re: /\b(young|older|mature|college|party|quiet|professional|student)\s+(crowd|scene|vibe|bunch|group)\b/,
    detail: 'describes the residents as a type',
  },
  {
    rule: 'fair_housing.religion',
    re: /\b(christian|catholic|jewish|muslim|mormon|church ?going|god fearing|faith based)\s+(community|building|area|neighborhood|complex|people|crowd)\b|\bperfect for a (christian|catholic|jewish|muslim|mormon)\b/,
    detail: 'sorts housing by religion',
  },
  {
    rule: 'fair_housing.national_origin',
    re: /\b(american citizens only|no immigrants|english speaking only|must speak english|where are you from originally|are you a citizen|green card)\b/,
    detail: 'sorts housing by national origin or citizenship',
  },
  {
    rule: 'fair_housing.disability',
    re: /\b(able bodied|no wheelchairs|must be able to (walk|climb)|not for disabled|whats your disability|what is your disability|how disabled)\b/,
    detail: 'sorts housing by disability, or probes a disability',
  },
  {
    rule: 'fair_housing.suitability',
    re: /\b(perfect|ideal|great|best|better) for (singles|couples|young professionals|professionals only|bachelors|families)\b/,
    detail: 'declares who a property suits',
  },
];

/** Promises nobody automating a leasing inbox is allowed to make. */
export const OVERPROMISE_TERMS = [
  'guaranteed approval', 'guarantee approval', 'you will be approved', 'youll be approved',
  'i can get you approved', 'approval is guaranteed', 'no credit check needed',
  'i guarantee', 'guaranteed to', '100% approval', 'definitely approved',
  'lowest price in', 'best deal in the city', 'cheapest in',
];

/** Text that tells a lead they are talking to software. */
export const ROBOTIC_TERMS = [
  'as an ai', 'as a language model', 'i am an ai', 'i cannot browse',
  'i do not have access to real-time', 'my training data', 'i apologize for any inconvenience',
];

/**
 * @typedef {Object} GuardrailViolation
 * @property {'block'|'warn'} severity
 * @property {string} rule
 * @property {string} detail
 * @property {string} [match]
 *
 * @typedef {Object} GuardrailResult
 * @property {boolean} ok
 * @property {boolean} blocked
 * @property {GuardrailViolation[]} violations
 * @property {string[]} parts        Possibly repaired message parts.
 */

/**
 * @param {string[]} parts
 * @param {{profile?: import('../voice/profile.js').VoiceProfile, business?: any,
 *          conversation?: import('../core/types.js').Conversation, maxChars?: number,
 *          fragments?: {act: string, text: string}[]}} ctx
 * @returns {GuardrailResult}
 */
export function checkOutbound(parts, ctx = {}) {
  /** @type {GuardrailViolation[]} */
  const violations = [];
  const maxChars = ctx.maxChars ?? 950; // Instagram caps DMs at 1000 characters.
  const joined = parts.join(' \n ').toLowerCase();

  // A compliance answer necessarily talks about the thing it is refusing to do
  // ("fair housing keeps me out of describing areas or who lives there"), so
  // scanning it for steering language flags the very reply that prevents
  // steering. Those fragments are our own approved wording; every other rule
  // still applies to them.
  const steeringText = ctx.fragments
    ? ctx.fragments
        .filter((f) => !String(f.act ?? '').startsWith('compliance.'))
        .map((f) => f.text)
        .join(' \n ')
        .toLowerCase()
    : joined;

  for (const { rule, re, detail } of STEERING_RULES) {
    const match = steeringText.match(re);
    if (match) {
      violations.push({
        severity: 'block',
        rule,
        detail: `Reply ${detail} ("${match[0].trim()}"). That is steering under the Fair Housing Act.`,
        match: match[0].trim(),
      });
    }
  }

  for (const term of OVERPROMISE_TERMS) {
    if (joined.includes(term)) {
      violations.push({
        severity: 'block',
        rule: 'overpromise',
        detail: `Reply promises an outcome the property controls ("${term}").`,
        match: term,
      });
    }
  }

  for (const term of ROBOTIC_TERMS) {
    if (joined.includes(term)) {
      violations.push({
        severity: 'block',
        rule: 'voice.robotic',
        detail: `Reply reveals itself as generated text ("${term}").`,
        match: term,
      });
    }
  }

  for (const term of ctx.profile?.banned ?? []) {
    if (joined.includes(String(term).toLowerCase())) {
      violations.push({
        severity: 'block',
        rule: 'voice.banned_phrase',
        detail: `Reply uses a phrase this voice never uses ("${term}").`,
        match: term,
      });
    }
  }

  // Never ask about children, ages, disability, national origin, or religion.
  if (/\b(how many kids|how old are your (kids|children)|do you have (kids|children)|are you married|where are you from originally|what church|your religion|are you disabled|whats your disability|are you a citizen)\b/i.test(joined)) {
    violations.push({
      severity: 'block',
      rule: 'fair_housing.protected_question',
      detail: 'Reply asks about a protected characteristic (familial status, religion, national origin, or disability).',
    });
  }

  // Occupancy is a legitimate question; phrasing it around children is not.
  if (/\bkids\b/.test(joined) && /\?/.test(joined)) {
    violations.push({
      severity: 'warn',
      rule: 'fair_housing.familial_status',
      detail: 'Reply mentions children in a question. Ask about lease occupants instead.',
    });
  }

  const repaired = [];
  for (const part of parts) {
    if (part.length > maxChars) {
      violations.push({
        severity: 'warn',
        rule: 'length',
        detail: `A message part exceeded ${maxChars} characters and was trimmed.`,
      });
      repaired.push(`${part.slice(0, maxChars - 1).trimEnd()}…`);
    } else {
      repaired.push(part);
    }
  }

  const questionCount = (joined.match(/\?/g) ?? []).length;
  if (questionCount > 2) {
    violations.push({
      severity: 'warn',
      rule: 'too_many_questions',
      detail: `Reply asks ${questionCount} questions. Leads answer one.`,
    });
  }

  // Repeating the previous outbound verbatim reads as a broken loop.
  const lastAgent = [...(ctx.conversation?.turns ?? [])].reverse().find((t) => t.role === 'agent');
  if (lastAgent && lastAgent.text.trim() && lastAgent.text.trim() === repaired.join('\n').trim()) {
    violations.push({
      severity: 'block',
      rule: 'duplicate',
      detail: 'Reply is identical to the previous message sent on this thread.',
    });
  }

  const blocked = violations.some((v) => v.severity === 'block');
  return { ok: !blocked, blocked, violations, parts: repaired };
}

/**
 * Inbound screen. Some messages should never be answered automatically at all,
 * no matter how confident the classifier is.
 * @param {import('../core/types.js').InboundMessage} inbound
 * @returns {{allow: boolean, reason?: string, escalate?: boolean}}
 */
export function checkInbound(inbound) {
  const text = String(inbound.text ?? '').toLowerCase();

  if (!text.trim() && !(inbound.attachments ?? []).length) {
    return { allow: false, reason: 'empty message' };
  }
  if (/\b(lawyer|attorney|sue|lawsuit|discriminat(e|ed|ion)|fair housing complaint|hud complaint|report you)\b/.test(text)) {
    return { allow: false, reason: 'legal or discrimination claim', escalate: true };
  }
  if (/\b(kill myself|suicide|hurt myself|domestic violence|being abused|emergency|call 911)\b/.test(text)) {
    return { allow: false, reason: 'safety concern', escalate: true };
  }
  return { allow: true };
}

/**
 * Quiet hours. A leasing DM at 3am reads as a bot no matter how good the copy
 * is, and several jurisdictions restrict solicitation hours outright.
 * @param {{quietStart: number, quietEnd: number, timezone?: string}} hours
 * @param {number} [now]
 */
export function withinQuietHours(hours, now = Date.now()) {
  const { quietStart, quietEnd, timezone } = hours ?? {};
  if (quietStart == null || quietEnd == null) return false;

  let hour;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(new Date(now)),
    );
  } catch {
    hour = new Date(now).getHours();
  }
  if (hour === 24) hour = 0;

  return quietStart > quietEnd ? hour >= quietStart || hour < quietEnd : hour >= quietStart && hour < quietEnd;
}
