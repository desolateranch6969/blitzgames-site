# Property Directory

The apartment communities, the companies above them, and the people who work at
them.

**Module 3.** Runs standalone — no database, no network, no imports from the
other modules.

```
npm test    # 63 tests, zero dependencies
```

---

## Two jobs

**1. Answer "who do I call about this property."**

The surfaced answer is deliberately small: the **leasing office** and the
**manager**. That is what a locator needs on screen. Everything else — the
assistant, the leasing team, maintenance, the regional, the corporate contacts —
is on the record, ordered by authority, one command away.

```
$ npm run who -- "maple" --store data/directory.json

The Maple, Uptown  Dallas
  under Alder Residential
  office     The Maple leasing office  leasing@themaple.com  +12145550100
  manager    Dana Price  (Property Manager)  +12145550101  dana@alderres.com
  +1 other contact(s) — use --all
```

**2. Keep industry contacts out of the renter funnel.**

This is the one that changes behavior elsewhere, and it is the reason the
directory has to exist before the inbox can be trusted.

A DM from a property's leasing manager looks exactly like a DM from a renter —
both mention units, budgets, and move dates. Without this check, the assistant
qualifies a property manager as a lead, asks her what her budget is, opens a
follow-up on her, and researches her. Every part of that is wrong, and it is
wrong in front of the exact people the business depends on.

So the check runs **upstream of triage**. An industry message never enters the
funnel to be filtered out of later.

---

## The hierarchy

One node type, not four fixed levels:

```
Alder Residential            [management_company]
  └ North Texas              [region]
      └ The Maple            [property]
          └ Building A       [building]
Cedar Group                  [management_company]
  └ Lark House               [property]
Owner-operated Flats         [property]         ← no parent, which is normal
```

Company structures vary and exceptions arrive immediately: some have regions,
some do not, plenty of properties are independently owned. A rigid four-level
model breaks on the first one. `kind` says what a node is; the tree does not
care.

Two mechanics keep it correct:

- **Materialized paths.** Each node stores its ancestor ids, so "everything
  under this company" is a filter rather than a recursive walk.
- **Cycle prevention.** A move that would make a node its own ancestor is
  refused. Without that check the next traversal loops forever.

Properties change management companies. `tree.move()` rewrites the whole
subtree's paths — and contact history survives it, because an assignment is its
own record.

---

## Titles

CRM exports spell one job a dozen ways. Everything downstream depends on
collapsing them:

| Written as | Becomes | Rank |
|---|---|---|
| Property Manager · Community Manager · Business Manager | `manager` | 2 |
| Assistant Property Manager · Asst. Mgr · APM | `assistant_manager` | 3 |
| Leasing Manager · Leasing Consultant · Concierge | `leasing` | 4 |
| Regional Manager · Area Director · RVP | `regional` | 1 |
| VP · Owner · Asset Manager | `corporate` | 0 |
| Leasing Office · info@ · rentals@ | `office` | — not a person |
| Maintenance Supervisor · Service Tech | `maintenance` | 6 |

Six rungs, not thirty. A taxonomy with thirty roles looks thorough and then
produces confident nonsense on the first unusual title.

**A "Leasing Manager" is not the Property Manager** — a distinction worth
getting right, since it decides who a locator calls first.

**Unrecognized titles stay unrecognized.** They keep their raw text, get rank
`null`, and land in a review list. A wrong rank is worse than a missing one: it
silently reorders who gets contacted.

```
titles not recognized (kept as written, no rank assigned)
     1  Resident Experience Curator
```

---

## Turnover is the normal case

Staff churn in this industry is relentless. If a contact's property were a field
on the contact, updating it would rewrite history, and "who did I work with at
The Maple last spring" would return the wrong person forever.

So assignments are dated records:

```js
roster.assign(kim.id, maple.id, { startedAt: '2025-01-01' });
roster.assign(kim.id, cedar.id, { startedAt: '2025-09-01' });  // ends the first

roster.at(maple.id);                              // she is not there now
roster.at(maple.id, { asOf: '2025-03-01' });      // but she was in March
```

The same person can also outrank themselves at different properties — a leasing
agent at one, the manager at another. The assignment's role wins.

---

## Importing the CRM

The CRM is unknown until the export lands, so nothing is assumed about it beyond
the shape every leasing CRM export shares: **a denormalized table, one row per
contact, with the property repeated across rows.**

```bash
# 1. See what it thinks each column is. Writes nothing.
npm run inspect -- --file ~/Downloads/export.csv

# 2. See what it would do. Writes nothing.
npm run import -- --file ~/Downloads/export.csv --dry-run

# 3. Do it.
npm run import -- --file ~/Downloads/export.csv --store data/directory.json
```

Columns are auto-detected from human-written headers (`Community`, `Mgmt Co`,
`ST`, `Asst. Mgr`), and anything it cannot place is reported rather than
guessed. Override with `--map propertyName="Site Code"`, repeatable.

Three properties matter more than features here:

- **Dry run first.** An import that misreads a column and invents 400 properties
  is a day of cleanup.
- **Idempotent.** Re-running the same export changes nothing — exports get
  re-pulled constantly, and that has to be safe. A blank column never overwrites
  a known value, which is how re-imports quietly erase data.
- **Nothing is dropped silently.** Every skipped row comes back with its
  spreadsheet row number, the reason, and the data, so it can be corrected and
  re-fed.

Matching is on **name + city + street number**, not name alone — "The Maple"
exists in a dozen cities.

The CSV parser is written properly rather than split-on-comma: quoted fields,
embedded commas and newlines, escaped quotes, CRLF, BOM, and tab/semicolon/pipe
delimiters. A real export contains all of those, and each one silently corrupts
a naive parser.

---

## The crawler seam

The crawler is coming from elsewhere and its guardrails are being rebuilt by
whoever owns it, so this defines **the shape of what comes back and nothing
about how it is gathered**. No fetching, no rate limiting, no politeness policy,
no robots handling — those belong to the crawler.

```js
directory.ingestDiscovered(records, {
  sourceName: 'property-crawler',
  policy: (record) => inMarket(record) ? { accept: true } : { accept: false, reason: 'out of market' },
});
```

`policy` is where the owner's guardrails attach without editing this module.
Rejected records come back listed, not silently dropped. Accepted records flow
through the same path as a CRM import — one code path, not two — and carry their
own provenance, so a crawled value is never indistinguishable from one a person
typed.

---

## Wiring the separation

Injected, not imported. Either module still runs without the other.

```js
import { createDirectory } from './property-directory/src/index.js';
import { createIngestor } from './lead-ingestor/src/index.js';

const directory = createDirectory({ store });

const ingestor = createIngestor({
  identifyParty: directory.partyResolver(),   // ← the whole integration
  onHandoff: ({ lead, sheet }) => replyEngine.handle(...),
});
```

What then happens to a message from Dana Price, property manager at The Maple:

```
disposition   industry_contact
reason        Dana Price is on file as property manager at The Maple
              → not handed to the reply engine
              → not enriched
              → not counted as a lead
              → announced on industry.message for the console to route
```

Matching strength is explicit, because the weak case matters:

| Matched on | Confidence | What happens |
|---|---|---|
| Instagram handle, email, or phone of a known contact | `certain` | Routed as industry |
| Email *domain* of a known management company | `probable` | Routed, but flagged for a person — the company being known does not make this individual staff |
| Nothing | — | Treated as a customer, normally |

Free-mail domains (`gmail.com`, `outlook.com`, …) identify nobody. One leasing
agent on a personal Gmail must never brand every Gmail user in the inbox as
industry.

If the directory throws or is unavailable, the sender is treated as a customer.
Worst case a manager gets a polite qualifying question and a human corrects it —
which is far better than an outage silencing the inbox.

---

## Commands

```
inspect  --file <export.csv>                   what each column looks like
import   --file <export.csv> [--dry-run]       load it
         [--store <file.json>] [--map f=Col] [--company "Name"]
tree     --store <file.json>                   the hierarchy
who      "property name" [--all]               the office and the manager
gaps     --store <file.json>                   what each property is missing
escalate <contactId>                           who sits above a contact
```

`gaps` names what is missing rather than scoring completeness:

```
Cedar Row       no leasing office contact
Lark House      no leasing office contact, only a regional contact — no site staff
```

---

## Layout

```
src/
  index.js              createDirectory() — the public surface
  core/types.js         OrgNode, Contact, Assignment
  tree/tree.js          hierarchy, paths, moves, merges, natural key
  contacts/
    titles.js           the ladder, normalization, the office/manager view
    contacts.js         contacts and dated assignments
  party/party.js        industry vs customer — the separation
  import/
    csv.js              a real CSV parser
    importer.js         column detection, dry run, idempotent upsert
  sources/source.js     the crawler seam and its policy hook
  store/index.js        memory + file
  cli.js
test/                   63 tests
```

---

## Not built yet

- **Property ↔ lead links** — what was sent, toured, applied to. The lead
  ingestor has the leads; nothing joins them yet.
- **Guest card / referral tracking.** In locating, the fee depends on his name
  being on the guest card *before* the tour. It belongs on this join.
- **Unit-level inventory.** Nodes support a `unit` kind, nothing populates it.
  It only becomes worth having when there is a live availability feed.
- **Contact deduplication across companies.** The importer matches within a
  property; a person who appears at two companies under two emails will be two
  records until someone merges them.
