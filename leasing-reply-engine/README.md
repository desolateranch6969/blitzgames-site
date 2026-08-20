# Leasing Reply Engine

Automated Instagram DM handling for an apartment locator/broker, written so it
sounds like the person whose account it runs on.

This is **module 1** of a larger leasing automation system. It runs completely on
its own today — no database, no API key, no other module — and it is built around
two seams (an event bus and a capability registry) that everything bolted on
later plugs into without this code changing.

```
npm test          # 130 tests, no dependencies to install
npm run chat      # talk to it as if you were a lead
```

---

## What it does today

Reads an incoming DM, works out what the lead wants, keeps track of what it has
learned about them, and answers in the agent's voice — one question at a time,
the way a working locator actually texts.

```
lead: hey saw your reel, looking for a 2 bed in uptown
agent: hey! ok cool, 2 bed in uptown
agent: when are you trying to move?
lead: september 1st, budget around 2k
agent: got it — up to $2,000, moving sep 1
agent: any pets?
lead: do you charge anything?
agent: nope costs you nothing. the property pays my side when you lease
```

It captures the things that decide which properties will actually take a lead —
budget, timing, bed/bath, area, occupancy, pets, income, and rental history
(broken lease, eviction, background) — and emits a structured lead summary the
moment there is enough to work with.

It also knows what **not** to answer. Fair-housing questions ("is that a safe
area?", "how are the schools?") get a neutral, factual response and a human,
every time. See [Compliance](#compliance) — it is the part of this most worth
reading.

---

## The one design decision everything else follows from

**The planner decides *what* to say. The realizer decides *how it sounds*.**

```
inbound DM
   ↓
classify + extract slots        what did they say, what did we learn
   ↓
PLANNER  → [ack.criteria, answer.fee, ask.moveIn]     ← deterministic, testable
   ↓
REALIZER → "ok cool, 2 bed in uptown"                 ← voice profile, swappable
           "nope costs you nothing, the property pays my side"
           "when are you trying to move?"
   ↓
guardrails → pacing → send
```

The planner emits *speech acts* — a short list like `ack.criteria`, `answer.fee`,
`ask.moveIn`. It never writes a word. The realizer turns those acts into text
using a **voice profile**: a JSON file describing how one person writes.

That split is what makes the rest possible:

- **Swap the voice, keep the behavior.** A different profile produces the same
  commitments in different words. Fix a policy once and every voice inherits it.
- **Compliance is testable.** Whether a fair-housing question gets deflected is a
  property of the planner, provable in a unit test, independent of phrasing.
- **A model can be added safely.** With `REALIZER=llm`, Claude rewrites an
  already-decided reply in his voice. It cannot change what was promised, what
  was asked, or what was declined — and if it fails, times out, or refuses, the
  deterministic realizer's output is already sitting there as the fallback.

---

## Making it sound like him

This is the part built for the corpus you are collecting. Nothing else in the
engine changes when the real samples land.

**Today** it ships with `standard-locator` — a plausible baseline voice for the
trade, written as a placeholder. Look at it with:

```bash
npm run voice -- --sample      # a sample line for every speech act
```

**When you have his DMs**, drop them in and build a profile:

```bash
# paired lead/agent messages, one JSON object per line
npm run learn -- --corpus src/voice/corpus/dms.jsonl --id mike --out src/voice/profiles/mike.json

# or straight from an Instagram data export
npm run learn -- --ig-export message_1.json --me "His Display Name" --id mike --out src/voice/profiles/mike.json
```

Then `VOICE_PROFILE=mike` and every reply is in his words. No code changes.

`learn` measures what can be measured and says what it could not:

| Measured | From |
|---|---|
| capitalization, punctuation, exclamation habits | every outgoing message |
| emoji rate and which emoji he actually uses | frequency across messages |
| abbreviations (`u`, `w/`, `apt`) and how often | hits vs. long-form misses |
| one message or three short ones | runs of consecutive messages |
| verbal tics ("for sure", "i got you") | phrases recurring across *different* sentences |
| his real wording per speech act | messages bucketed by what they were doing |
| few-shot examples for the model realizer | lead/agent pairs, spread across acts |

It prints exactly which speech acts got real examples and which are still using
baseline wording, so there is no guessing about coverage. Anything the corpus
does not cover falls back to the baseline profile rather than going silent.

Sample-size guidance is in [`src/voice/corpus/README.md`](src/voice/corpus/README.md),
along with the note that a DM corpus is real conversations with real people —
keep it out of git (already gitignored) and strip personal details before use.

---

## Bolting on the next module

The engine never calls anything directly. It **emits facts** and **asks whether
anyone can do a thing yet**.

### Events — for anything that wants to observe

```js
engine.bus.on('lead.qualified', ({ summary }) => crm.push(summary));
engine.bus.on('tour.requested', ({ summary }) => scheduler.open(summary));
engine.bus.on('human.requested', ({ summary, reason }) => notify(summary, reason));
engine.bus.on('compliance.flagged', ({ violations }) => auditLog(violations));
```

Full list in [`src/core/bus.js`](src/core/bus.js). A subscriber that throws is
isolated — it can never take down a reply.

### Capabilities — for anything that wants to extend behavior

The planner asks the host whether a capability exists. Nothing provides
`listings.search` today, so it plans a promise. Register a module that does, and
the same conversation starts returning real units:

```js
engine.use({
  name: 'listings',
  provides: ['listings.search'],
  setup(ctx) {
    ctx.provide('listings.search', async ({ slots }) => searchMls(slots));
  },
});
```

```
without the module:  "let me pull a few that fit and ill send them over"
with the module:     "check these out:
                      1) The Maple — uptown — $1,795-$1,950 — 4 weeks free
                      2) Lark House — uptown — $1,975-$2,200 — look and lease $500 off"
```

No edit to the planner. Run it yourself:

```bash
node examples/with-modules.js
```

Capabilities the planner already looks for: `listings.search`,
`tours.availability`. Working examples in [`examples/modules/`](examples/modules).

### Hooks — for anything that wants to intervene

`onInbound`, `beforeClassify`, `afterClassify`, `afterExtract`, `beforePlan`,
`afterPlan`, `beforeRealize`, `afterRealize`, `beforeSend`, `afterSend`.

```js
engine.use({
  name: 'approval-gate',
  setup: () => ({
    hooks: {
      beforeSend: (turn) => {
        if (needsReview(turn)) turn.scratch.cancelSend = true;
      },
    },
  }),
});
```

### For the management portal specifically

When you build it, three things are already waiting:

- `engine.store` — the conversation store behind a four-method interface
  (`get`, `save`, `list`, `seen`). Swap the JSON-file store for Postgres by
  providing a `store` capability; nothing else changes.
- `GET /conversations` and `GET /conversations/:threadId` — read-only lead
  summaries and full transcripts, already served.
- `autoSend: false` — composes every reply, marks it `requiresApproval`, and
  hands it back instead of sending. That is the human-in-the-loop review queue
  the portal will want on day one.

---

## Compliance

An automated leasing inbox does fair-housing violations *at volume*. This is the
liability that matters, so it is enforced in two independent places.

**The planner routes them.** A steering question never reaches the sales path:

```
lead:  is that a safe area for my family?
agent: i cant speak to what an area or the people in it are like, thats a fair
       housing thing i have to stay out of. what i can do is send you the
       addresses so you can look at public crime maps, school ratings, and drive
       it yourself
agent: let me look at that one myself and ill come right back to you
       → thread marked awaiting_human, compliance.flagged emitted
```

Also routed: assistance animals (never treated as pets, never probed), disclosed
accessibility needs, housing vouchers, and any message mentioning discrimination
or a legal claim — that last one gets **no** automated reply at all.

**The guardrails catch them.** Every finished reply is scanned before sending,
whichever backend wrote it, blocking anything that characterizes an area or its
residents, mentions crime or schools, sorts housing by children/religion/national
origin/disability, promises an approval the property controls, or reveals itself
as generated text. A blocked reply falls back to a safe handoff and flags the
thread.

Two things worth knowing:

- Compliance fragments are **never restyled** — no abbreviating, no emoji, no
  clipping. The wording survives intact whatever voice is loaded.
- The guardrails skip steering checks on the engine's *own* compliance answers,
  since a sentence declining to describe a neighborhood necessarily mentions
  describing neighborhoods. Every other rule still applies to them.

None of this is legal advice, and the broker remains responsible for what goes
out under their license. It is a floor, not a ceiling — review it with whoever
handles his compliance.

---

## Instagram

```bash
cp .env.example .env    # fill in the IG_* values
npm run serve
```

| Endpoint | Purpose |
|---|---|
| `GET /webhook/instagram` | Meta subscription handshake |
| `POST /webhook/instagram` | inbound DMs, HMAC-verified against the raw body |
| `POST /simulate` | `{"text": "..."}` → composed reply, no Meta account needed |
| `GET /conversations` | recent threads |
| `GET /health` | what is loaded |

On the Meta side: an Instagram professional account linked to a Facebook Page, a
Meta app subscribed to the `messages` field, permissions `instagram_basic` +
`instagram_manage_messages` + `pages_manage_metadata`, and a public HTTPS
callback URL. Meta requires privacy-policy and terms URLs at app review.

The adapter handles what actually bites in production: signature verification on
raw bytes, skipping our own echoed messages (otherwise it talks to itself),
webhook-retry deduplication, media-only messages, the 1000-character DM cap, and
the platform's 24-hour reply window (`enforceReplyWindow: true`).

Pacing is deliberate: replies arrive as one to three bubbles with typing delays
scaled to message length, quiet hours are respected, and per-thread and
per-account rate limits are enforced.

---

## Configuration

Everything is optional. `createEngine()` with no arguments works.

```js
import { createEngine } from './src/index.js';

const engine = createEngine({
  voiceProfile: 'standard-locator',  // or 'mike', or a profile object
  realizer: 'template',              // or 'llm'
  store: 'file',                     // or 'memory', or bring your own
  autoSend: true,                    // false = compose for human approval
  business: {
    agentName: 'mike',
    market: { name: 'Dallas', areas: [{ name: 'Uptown', aliases: ['uptown'] }] },
    screening: { incomeMultiple: 3 },
    hours: { quietStart: 21, quietEnd: 8, timezone: 'America/Chicago' },
    compliance: { licenseDisclosure: '...', requireGuestCard: true },
  },
});

const result = await engine.handle(inboundMessage);
```

**Business facts and voice are separate on purpose.** Voice is how he sounds;
the business profile is what is true. Swapping voices must never change a fee,
and correcting a fee must never mean editing a phrase bank.

Markets are configuration too — the engine ships knowing no city. Hand it a
market file and it understands that city's neighborhoods.

Env vars are documented in [`.env.example`](.env.example).

---

## Layout

```
src/
  index.js              engine: the turn pipeline, the public API
  core/                 bus, module host + hooks + capabilities, seeded rng
  domain/               the leasing knowledge
    intents.js            what a DM is asking (extensible taxonomy)
    slots.js              budget, timing, beds, area, pets, income, screening
    conversation.js       state, ask ordering, qualification
    planner.js            what to say  ← the decisions live here
    business.js           facts about his business
  voice/                  how it sounds
    profile.js            schema, loading, merging
    profiles/*.json       voice packs (swap freely)
    compose.js            template realizer
    humanize.js           casing, abbreviations, emoji, bubbles, tics
    learn.js              build a profile from real messages
  generation/           model-backed realizer (Claude), template fallback
  policy/               guardrails, rate limits, reply window
  channels/             instagram, console (same three-method contract)
  store/                memory + file (swap for a database)
  server/http.js        webhooks + read-only ops API
examples/               working bolt-on modules and a demo
test/                   130 tests
```

Zero runtime dependencies. Plain ESM with JSDoc types — `tsc --checkJs` type-checks
it without a build step, and it can move to TypeScript later without rework.

---

## What is deliberately not built yet

Named so the next module has a clear starting point, not because they were
forgotten:

- **Listing search** — the planner already asks for `listings.search` and
  degrades gracefully. `examples/modules/listings-module.js` is the shape.
- **Tour scheduling** — same, via `tours.availability` / `tours.book`.
- **Management portal** — the store interface, the read-only endpoints, and
  `autoSend: false` are the hooks it will want.
- **CRM sync** — subscribe to `lead.qualified`; see the lead-log example.
- **Follow-up sequences** — deliberately absent. Unsolicited follow-ups are the
  fastest way to get an Instagram account restricted, and they need the reply-
  window rules in `policy/rate-limit.js` wired to a scheduler first.
- **Multi-agent / team routing** — the conversation model has room for it
  (`status: awaiting_human`, assignment), but there is no team concept yet.
