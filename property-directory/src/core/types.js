/**
 * Shared shapes for the property directory.
 *
 * Three records, and the split between them is deliberate:
 *
 *   OrgNode    Anything in the ownership hierarchy — a management company, a
 *              region, a property, a building. One record type, not four,
 *              because the shape of these hierarchies varies by company and a
 *              rigid four-level model breaks on the first exception.
 *   Contact    A person at a node. Contacts churn constantly in this industry,
 *              so an assignment is a dated record, not an overwrite.
 *   Assignment The link between them, with a start and an end. This is what
 *              lets "who did I work with at The Maple in 2024" still answer
 *              correctly after that person has left.
 *
 * @typedef {'management_company'|'portfolio'|'region'|'property'|'building'|'group'} NodeKind
 *
 * @typedef {Object} OrgNode
 * @property {string} id
 * @property {NodeKind} kind
 * @property {string} name
 * @property {string|null} parentId
 * @property {string[]} path        Ancestor ids, root first. Materialized for subtree queries.
 * @property {number} depth
 * @property {Address} [address]
 * @property {Record<string, unknown>} attrs   Unit count, year built, website — open by design.
 * @property {SourceRef[]} sources  Where each version of this record came from.
 * @property {'active'|'inactive'|'merged'} status
 * @property {string} [mergedInto]
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {Object} Address
 * @property {string} [line1]
 * @property {string} [city]
 * @property {string} [state]
 * @property {string} [zip]
 *
 * @typedef {Object} SourceRef
 * @property {string} source        'crm-import' | 'crawler' | 'operator' | custom
 * @property {string} at
 * @property {string} [reference]   File name, URL, or record id in the origin system.
 *
 * @typedef {Object} Contact
 * @property {string} id
 * @property {string} [firstName]
 * @property {string} [lastName]
 * @property {string} displayName
 * @property {string} [rawTitle]    Exactly as the origin system had it.
 * @property {string} role          Normalized role id — see contacts/titles.js.
 * @property {number|null} level    Authority rank; null when the title is unrecognized.
 * @property {ContactChannel[]} channels
 * @property {SourceRef[]} sources
 * @property {'active'|'departed'|'unknown'} status
 * @property {string} [notes]
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {Object} ContactChannel
 * @property {'email'|'phone'|'instagram'|'other'} kind
 * @property {string} value         Normalized.
 * @property {boolean} [primary]
 *
 * @typedef {Object} Assignment
 * @property {string} id
 * @property {string} contactId
 * @property {string} nodeId
 * @property {string} [role]        Overrides the contact's role at this node, if different.
 * @property {number|null} [level]
 * @property {string} startedAt
 * @property {string|null} endedAt  null while current.
 * @property {SourceRef} source
 */
export {};
