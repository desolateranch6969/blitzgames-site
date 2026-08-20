/**
 * Shared shapes for the lead ingestor.
 *
 * Three record types carry everything, and the separation between them is the
 * whole architecture:
 *
 *   RawEvent      What a source literally observed. Never edited, never
 *                 interpreted. If a triage rule turns out to be wrong, the raw
 *                 events are still there to re-run it against.
 *   Person        A human, resolved across sources. Owns identifiers and facts.
 *   Lead          One inbound approach from a Person. Owns triage and history.
 *
 * A Person can have many Leads over time (people come back six months later).
 * A Lead always belongs to exactly one Person.
 *
 * @typedef {Object} RawEvent
 * @property {string} id                  Stable within (source, sourceId).
 * @property {string} source              'graph-api' | 'archive' | 'device' | 'session' | custom
 * @property {'message'|'comment'|'mention'|'story_reply'|'follow'|'profile'} kind
 * @property {string} observedAt          ISO timestamp of when we saw it.
 * @property {string} [occurredAt]        ISO timestamp of when it happened, if known.
 * @property {SourceActor} actor          Who produced it.
 * @property {string} [threadId]          Conversation key within the source.
 * @property {string} [text]
 * @property {Record<string, unknown>} payload  The source's own shape, verbatim.
 *
 * @typedef {Object} SourceActor
 * @property {string} platform            'instagram' | 'linkedin' | 'web' | ...
 * @property {string} platformId          Stable id on that platform.
 * @property {string} [handle]
 * @property {string} [displayName']
 *
 * @typedef {Object} Identifier
 * @property {'instagram_id'|'instagram_handle'|'phone'|'email'|'linkedin_url'|'website'} kind
 * @property {string} value               Normalized (see identity/handles.js).
 * @property {'strong'|'weak'} strength    Strong identifiers may auto-merge people.
 * @property {string} source
 * @property {string} observedAt
 *
 * @typedef {Object} Fact
 * @property {string} field               Dotted path, e.g. 'instagram.followers'.
 * @property {unknown} value
 * @property {string} source              Provider name.
 * @property {string} [url]               Where a human can verify it.
 * @property {'api'|'public_page'|'operator'|'inferred'|'vendor'} method
 * @property {string} observedAt
 * @property {number} [confidence]        Confidence in THIS FACT, never a rating of the person.
 *
 * @typedef {Object} Person
 * @property {string} id
 * @property {Identifier[]} identifiers
 * @property {string} [displayName]
 * @property {Fact[]} facts
 * @property {string[]} mergedFrom        Person ids folded into this one.
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {Object} Signal
 * @property {string} kind                See triage/signals.js.
 * @property {string} evidence            The words that produced it.
 * @property {string} source
 *
 * @typedef {Object} Triage
 * @property {string} disposition         See triage/triage.js DISPOSITIONS.
 * @property {string[]} reasons           Human-readable, in the order they applied.
 * @property {Signal[]} signals
 * @property {string[]} missing           What we would need to know to act.
 * @property {number} confidence          Confidence in the CLASSIFICATION.
 * @property {boolean} needsHuman
 *
 * @typedef {Object} Lead
 * @property {string} id
 * @property {string} personId
 * @property {string} source
 * @property {string} [threadId]
 * @property {string} firstSeenAt
 * @property {string} lastSeenAt
 * @property {string[]} eventIds
 * @property {Triage} [triage]
 * @property {'new'|'triaged'|'handed_off'|'enriched'|'archived'} state
 * @property {string} [handedOffAt]
 * @property {Record<string, unknown>} ext   Namespaced scratch for other modules.
 */
export {};
