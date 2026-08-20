# Lead Ingestor

Collects inbound approaches from Instagram, works out who the person is, decides
what kind of approach it was, and establishes what can be established about them
from public sources — then hands the real ones to the reply engine.

**Module 2** of the leasing automation system. Runs standalone, emits facts on a
bus, and never imports module 1.

```
npm test    # 95 tests, zero dependencies
```

---

## Where it sits

```
   ┌─────────────────────────────────────────────┐
   │  SOURCES                                    │
   │  export archive · Graph API · device rig     │
   └────────────────────┬────────────────────────┘
                        │  RawEvent (verbatim, append-only)
                        ▼
                    dedupe  ──────────────▶ already seen, stop
                        │
                        ▼
              identity resolution  ─────▶ Person (merged across sources)
                        │
                        ▼
                     triage  ────────────▶ disposition + signals + reasons
                        │
        ┌───────────────┼────────────────┬─────────────────┐
        ▼               ▼                ▼                 ▼
   reply engine    enrichment       hold for human      no action
   (module 1)      (background)     (portal queue)      (spam, vendors)
```

Everything before triage is faithful recording. Everything after is a decision
that can be re-run: raw events are append-only, so when a rule turns out to be
wrong it gets fixed and replayed over history instead of leaving bad
classifications permanently baked in.

---

## Collection: three paths, different tradeoffs

They are not alternatives, they are layers. Each covers what the one above it
cannot reach.

| | Coverage | Risk | Durability | Status |
|---|---|---|---|---|
| **Export archive** | Everything already in the inbox, years back | None — Meta hands the owner their own data | Permanent | **Implemented** |
| **Graph API** | New DMs to a professional account | None | High — breaks only on policy change | **Implemented** |
| **Device rig** | What the API cannot see: message requests, personal-account DMs, anything past the API window | Real — automation violates Meta's terms; the account carries it | Low — breaks on app updates | **Contract + adb plumbing** |

### The archive is the starting point

Not a fallback — the foundation. It needs no credentials, breaks nothing, and it
is where the corpus comes from. One read produces two things:

- historical leads to triage, so the system has something to work on before a
  single new DM arrives
- his side of every conversation, as a voice corpus for the reply engine

See [Exporting Instagram conversations](#exporting-instagram-conversations) below.

### The Graph API is the primary live path

Webhooks push into the same subscription the reply engine already uses, plus a
conversations sweep as a safety net (webhook delivery is best-effort, and a
restart loses whatever was in flight). What it cannot see is the reason the
device rig exists: it covers professional accounts only, within a retention
window, and never shows the hidden message-requests folder — which is exactly
where a cold lead from a stranger lands.

### The device rig, honestly

A dedicated phone on a powered hub, driven over `adb`. It exists for coverage,
not preference, and it is worth being clear-eyed about the cost: **automating
the app violates Instagram's terms, and the account bears the consequence, not
the server.** Detection is mostly behavioral — a poll cadence that never varies,
taps at identical coordinates, activity at 4am, reading faster than a human
scrolls. So `createPacer()` jitters every interval, sleeps overnight, and takes
irregular longer breaks. That pacing is not politeness; it is the difference
between a rig that runs for months and one that gets restricted in a week.

Use it as the layer beneath the API, and never point it at his main personal
account.

Read paths, least to most fragile:

1. **Notifications** — `adb shell dumpsys notification --noredact`. Sender and
   preview text without ever opening the app. Implemented (`parseNotificationDump`).
2. **UI dump** — `adb exec-out uiautomator dump /dev/tty`. Full text; selectors
   break on app updates.
3. **Screenshot + OCR** — `adb exec-out screencap -p` into Vision.framework.
   Survives layout changes, costs latency.

The selectors for (2) are deliberately left as a `DeviceDriver` interface rather
than hardcoded. They are version-specific and change without notice; baking
today's resource IDs into the architecture would be the least durable thing in
this repo.

**Logged-in web session** — the third path you mentioned — is the same
`Source` contract, and is deliberately not implemented. It carries the device
rig's terms risk without the device rig's coverage advantage: a session cookie
gets invalidated on any challenge, and re-authenticating from a server IP is
what triggers the challenge. If it turns out to be needed, it implements
`Source` and the pipeline behind it does not change.

---

## Triage: routing, not ranking

You said no rankings. This is built so that ranking is not merely absent but
structurally awkward to add — and there's a test asserting the output carries no
`score`, `rank`, `tier`, `grade`, `rating`, or `priority` field.

What comes out is a **disposition** — a routing decision — plus the signals and
reasons behind it:

| Disposition | Means | Next step |
|---|---|---|
| `prospective_renter` | A rental search is underway | Hand to reply engine, enrich |
| `needs_qualification` | Interested, nothing stated yet | Hand to reply engine, enrich |
| `general_question` | Asking about the service itself | Hand to reply engine |
| `not_serviceable` | Real person, wrong business (buying, sublet, job, out of market) | One kind reply, notify operator |
| `vendor_or_recruiter` | Selling something | No reply |
| `spam_or_bot` | Automated or fraudulent | No reply, no enrichment |
| `personal_or_social` | Someone he knows | Never automated |
| `unclear` | Not enough to classify | Held for a human glance |

Why no score, in one line each: a number compresses away the reason an operator
needs; scores get treated as measurements when they are guesses; and ranking
people by predicted value *in housing* builds exactly the machinery a fair
housing problem needs. Routing is not ranking — every disposition has a defined
next step, and none of them means "this person matters less."

Every decision carries `reasons` (readable) and `signals` (the words that
produced them):

```
$ npm run triage -- --text "hey saw your reel, need a 2 bed in uptown under 2k by sept 1, i had a broken lease in 2023"

  prospective_renter
  classifier confidence 0.85
    · stated they are looking for a place
    · disclosed rental history that narrows the property list

  signals
    stated_search            "need a 2 bed"
    stated_budget            "under 2k"
    stated_timeline          "sept 1"
    stated_area              "in uptown"
    screening_disclosure     "broken lease"
    referral                 "saw your reel"
```

Threads are classified as a whole, not message by message — people state a budget
in message three and "ok thanks" in message four, and classifying only the latest
would throw the lead away.

---

## Identity: strict on purpose

The rule is **auto-merge on strong identifiers only.**

| Identifier | Strength | Why |
|---|---|---|
| `instagram_id`, `phone`, `email`, `linkedin_url` | strong | People don't share them by accident |
| `instagram_handle` | weak | Handles get changed, released, and re-registered by someone else |
| `website` | weak | A dozen employees share a company domain |
| display name | not an identifier at all | — |

Weak matches produce a `person.merge_suggested` event for a human to confirm in
the portal. A wrong merge puts one person's phone number, income, and rental
history onto another person's record — and once merged, the boundary is gone.
That is the worst failure this module can have, so it is the one place where
being conservative costs almost nothing.

---

## Enrichment: facts with receipts

Every enriched value is a `Fact`: a value, its source, how it was obtained
(`api` / `public_page` / `operator` / `inferred` / `vendor`), when, and a URL a
human can open to check it. The orchestrator enforces a disposition gate (spam
is never researched), a per-person call budget, per-host politeness pacing, and
a cache TTL.

**Instagram** — the official `business_discovery` endpoint. Returns bio,
website, follower/post counts for *professional* accounts, no scraping involved.
For a personal account it records `profile_visibility: personal_or_private`
rather than nothing, because "we looked and could not see" is different from "we
never looked."

**Website / link-in-bio** — one page, robots.txt honored, size-capped. Often the
highest-value hop: a link-in-bio usually leads to the LinkedIn or company page
that actually identifies someone.

**LinkedIn — a resolver plus a vendor slot, not a scraper.** This is a
deliberate call worth stating plainly. A LinkedIn scraper would be the wrong
thing to build here, and not only because their user agreement prohibits it:
unauthenticated profile views hit a wall, authenticated scraping gets the
*account* restricted, and the selectors churn constantly. It would stop working
within weeks and put a real account at risk in the meantime. So the provider
does the two things that work and keep working:

1. **Resolves** a candidate profile URL from what the person already published —
   their IG bio, their link-in-bio site, their email domain. Nothing is fetched
   from LinkedIn. The URL lands on the prospect sheet as a link the operator
   clicks: one click, full profile, zero risk.
2. **Delegates** the actual lookup to an injected `vendorLookup` function, so a
   licensed data API (People Data Labs, Proxycurl, Clearbit — whichever) drops in
   without touching the file. That is how this data is obtained legitimately at
   volume, and it returns structured records instead of parsed HTML.

A resolved URL is marked `inferred` with a confidence and shown as
`(candidate, unconfirmed)` until a human confirms it. Nothing is ever presented
as though someone read a profile that nobody read.

### The prospect sheet

```
Jessica R  @jessicar
──────────────────────────────

disposition   prospective_renter
              · stated they are looking for a place

asked for
  budget             "under 2k"
  size               "2 bed"
  area               "in uptown"
  rental history     "broken lease"

profile
  instagram.followers          1200        [instagram-public/api]
  website.title                Jessica R — Nurse   [website/public_page]

sources disagree
  location.stated: Dallas (instagram-public) vs Fort Worth (linkedin)

not known
  · move date
  · no email

links
  Instagram   https://instagram.com/jessicar
  LinkedIn    https://www.linkedin.com/in/jessica-r-123  (candidate, unconfirmed)
```

Sources that disagree are shown as disagreeing rather than silently resolved.
Gaps are stated so the next message has an obvious purpose.

---

## Exporting Instagram conversations

Full walkthrough, on a Mac.

**1. Request the export** — in a browser, go to
**[accountscenter.instagram.com](https://accountscenter.instagram.com)** and sign in.

> Your information and permissions → **Export your information** → **Create export**
> → choose the Instagram account → **Export to device**

Then set:

| Setting | Value | Why it matters |
|---|---|---|
| Date range | **All time** | The whole point is the back catalogue |
| Format | **JSON** | HTML is unparseable — this is the one that ruins an export |
| Media quality | Low | Messages are text; low quality keeps the zip small |
| Information | **Messages** (at minimum) | Everything else is optional |

Start export. Meta emails a download link when it is ready — usually a few hours,
occasionally up to ~48. Deleted conversations and unsent messages are not
included.

**2. Unzip it.** Double-click the `.zip` in Downloads. You get a folder like
`instagram-<handle>-<date>/` containing `your_instagram_activity/messages/inbox/`.

**3. Check it before doing anything else:**

```bash
cd lead-ingestor
node src/cli.js inspect-archive --path ~/Downloads/instagram-yourhandle-2026-08-20
```

It reports thread and message counts, the date range, and **which display name is
the account owner** — detected by thread presence, not message volume, because
the owner is in every thread by definition while the chattiest single person
might just be one talkative lead. It tells you when it is not certain.

**4. Import:**

```bash
node src/cli.js import-archive \
  --path ~/Downloads/instagram-yourhandle-2026-08-20 \
  --me "His Display Name" \
  --store data/leads.json \
  --corpus-out data/voice-corpus.jsonl
```

That single command produces both halves: triaged historical leads, and the voice
corpus for module 1.

```bash
cd ../leasing-reply-engine
npm run learn -- --corpus ../lead-ingestor/data/voice-corpus.jsonl \
  --id his-voice --out src/voice/profiles/his-voice.json
```

**What to send me:** `data/voice-corpus.jsonl` is the useful artifact — it is
already just message text, no media, no follower graph, no account metadata. It
is real conversations with real people, so strip or spot-check names, phone
numbers, and addresses before it leaves the machine. `.gitignore` already
excludes both the corpus and the export.

---

## Running it on a Mac

**Node** — `brew install node` (needs 20+). No other dependencies.

**Scheduling** — `launchd`, not cron. A LaunchAgent survives reboot and logs
properly. `~/Library/LaunchAgents/com.leasing.ingestor.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.leasing.ingestor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/you/leasing/lead-ingestor/src/server/run.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/leasing/lead-ingestor</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/leasing-ingestor.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/leasing-ingestor.err</string>
</dict></plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/com.leasing.ingestor.plist
```

**Secrets** — Keychain, not a `.env` on disk:

```bash
security add-generic-password -a "$USER" -s IG_PAGE_ACCESS_TOKEN -w
export IG_PAGE_ACCESS_TOKEN=$(security find-generic-password -a "$USER" -s IG_PAGE_ACCESS_TOKEN -w)
```

**Sleep** — a Mac that sleeps stops polling. `caffeinate -s` for a session, or
Settings → Displays → Advanced → "Prevent automatic sleeping" for a machine
acting as a server. A Mac mini on ethernet is the right shape for this.

**Device rig** — `brew install android-platform-tools`, enable USB debugging on
the phone (Settings → About → tap Build number seven times), plug into a
*powered* hub so it charges under load, then `adb devices` should list it as
`device` and not `unauthorized`.

**Backups** — `data/leads.json` is the whole dataset. Time Machine covers it;
just don't put it in a synced Dropbox/iCloud folder, where a partial write can
be replicated mid-flush.

---

## Bolting it together

**To the reply engine** — one injected function, no import:

```js
import { createIngestor } from './lead-ingestor/src/index.js';
import { createEngine } from './leasing-reply-engine/src/index.js';

const replyEngine = createEngine({ voiceProfile: 'his-voice' });

const ingestor = createIngestor({
  market: { name: 'Dallas', areas: ['uptown', 'deep ellum', 'oak lawn'] },
  extractSlots,                      // module 1's extractor, sharpens triage signals
  onHandoff: async ({ lead, person, sheet }) => {
    await replyEngine.handle(toInbound(lead, person));
  },
});
```

Either module can be deployed, tested, or replaced without the other.

**To the portal**, when you build it — four things are already waiting:

- `ingestor.store` — people, leads, and events behind an interface a Postgres
  implementation can satisfy
- `ingestor.prospectSheet(personId)` — the page the portal renders
- `person.merge_suggested` — the review queue for identity decisions
- `lead.held` — the queue of things a human needs to look at, with the reason

Every event is on the bus: `lead.opened`, `lead.triaged`, `lead.handed_off`,
`lead.held`, `person.created`, `person.merge_suggested`, `person.enriched`,
`source.health`.

---

## Layout

```
src/
  index.js                 the pipeline and public API
  core/types.js            RawEvent, Person, Lead — the three records
  sources/
    source.js              the Source contract, cursors, failure isolation
    archive.js             Instagram export reader (+ voice corpus)
    graph-api.js           official webhook + polling source
    device-bridge.js       phone rig: adb, pacing, notification parsing
  identity/
    handles.js             normalization, identifier strength
    identity.js            resolution, merge rules, fact attachment
  triage/
    signals.js             detectors — registerable
    triage.js              dispositions and routing
  enrichment/
    enricher.js            budget, cache, politeness, disposition gate
    providers/             instagram-public, website, linkedin
    prospect-sheet.js      the assembled view
  store/index.js           memory + file, same interface
  cli.js
test/                      95 tests, including a synthetic Instagram export
```

---

## Not built yet

- **HTTP server** (`src/server/`) — the launchd entry point. Trivial; the reply
  engine's `server/http.js` is the template.
- **Comment and story-mention sources** — same `Source` contract, different Graph
  API subscription.
- **Retention policy** — enrichment accumulates personal data on people who only
  sent a DM. Before this holds real volume it needs a TTL on enriched facts for
  non-converting leads, and a delete path for a person who asks.
- **Vendor provider** — the slot exists and is tested; it needs an actual API key
  and a decision about which vendor.
- **Re-triage over history** — the raw events make it possible; the command to
  replay them after a rule change is not written.
