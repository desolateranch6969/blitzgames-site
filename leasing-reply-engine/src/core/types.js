/**
 * Shared shapes for the engine. Plain JSDoc so the module stays dependency-free
 * and buildless; every editor and `tsc --checkJs` still gets full types.
 *
 * @typedef {Object} InboundMessage
 * @property {string} id                 Channel-native message id (dedupe key).
 * @property {string} channel            'instagram' | 'console' | future adapters.
 * @property {string} threadId           Stable conversation key within the channel.
 * @property {string} senderId           Channel-native sender id.
 * @property {string} [senderName]
 * @property {string} [senderHandle]
 * @property {string} text
 * @property {Attachment[]} [attachments]
 * @property {number} receivedAt         Epoch ms.
 * @property {Record<string, unknown>} [raw]
 *
 * @typedef {Object} Attachment
 * @property {'image'|'video'|'audio'|'share'|'story_mention'|'unknown'} type
 * @property {string} [url]
 *
 * @typedef {Object} OutboundMessage
 * @property {string} threadId
 * @property {string} channel
 * @property {string[]} parts            One or more DM bubbles, in send order.
 * @property {number[]} delaysMs         Pre-send delay for each part (typing cadence).
 * @property {OutboundMeta} meta
 *
 * @typedef {Object} OutboundMeta
 * @property {string[]} speechActs       Planner output that produced these parts.
 * @property {string} realizer           'template' | 'llm' | module-provided.
 * @property {string} voiceProfile
 * @property {string} [plannerNote]      Human-readable reason, for the future portal.
 * @property {boolean} [requiresApproval]
 *
 * @typedef {Object} Slots
 * @property {{min?: number, max?: number, raw?: string}} [budget]
 * @property {{iso?: string, text?: string, flexible?: boolean}} [moveIn]
 * @property {number} [beds]
 * @property {number} [baths]
 * @property {string[]} [areas]
 * @property {number} [occupants]
 * @property {{has: boolean, kind?: string, count?: number, weightLb?: number}} [pets]
 * @property {{monthlyGross?: number, meetsThreeX?: boolean}} [income]
 * @property {{brokenLease?: boolean, eviction?: boolean, felony?: boolean, misdemeanor?: boolean, bankruptcy?: boolean}} [screening]
 * @property {{phone?: string, email?: string, preferred?: 'dm'|'phone'|'text'|'email'}} [contact]
 * @property {string[]} [amenities]
 * @property {string} [workLocation]
 * @property {string} [tourAvailability]
 *
 * @typedef {Object} Turn
 * @property {'lead'|'agent'|'system'} role
 * @property {string} text
 * @property {number} at
 * @property {string[]} [intents]
 * @property {string[]} [speechActs]
 *
 * @typedef {Object} Conversation
 * @property {string} threadId
 * @property {string} channel
 * @property {{id: string, name?: string, handle?: string}} contact
 * @property {Slots} slots
 * @property {Turn[]} turns
 * @property {string} stage             See domain/conversation.js STAGES.
 * @property {'active'|'awaiting_human'|'closed'|'opted_out'} status
 * @property {Record<string, unknown>} flags
 * @property {string[]} askedSlots      Slots already asked, so we never re-ask.
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} [lastInboundAt]
 * @property {number} [lastOutboundAt]
 * @property {Record<string, unknown>} [ext]  Namespaced scratch space for other modules.
 *
 * @typedef {Object} Classification
 * @property {string} primary
 * @property {string[]} all
 * @property {number} confidence
 * @property {Record<string, number>} scores
 *
 * @typedef {Object} PlanStep
 * @property {string} act              Speech act id, e.g. 'ask.budget'.
 * @property {Record<string, unknown>} [data]
 *
 * @typedef {Object} Plan
 * @property {PlanStep[]} steps
 * @property {string} [note]
 * @property {boolean} [handoff]
 * @property {boolean} [silent]        Plan deliberately says nothing.
 *
 * @typedef {Object} TurnContext
 * @property {InboundMessage} inbound
 * @property {Conversation} conversation
 * @property {Classification} [classification]
 * @property {Plan} [plan]
 * @property {OutboundMessage} [outbound]
 * @property {string[]} notes
 * @property {Record<string, unknown>} scratch
 */
export {};
