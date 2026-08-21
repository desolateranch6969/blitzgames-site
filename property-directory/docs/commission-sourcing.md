# Where broker commission data comes from

Notes from a sourcing review, and the decision that came out of it. Nothing here
is built yet — this records the route so the work does not have to be rediscovered.

## The question

Every property pays a locator some agreed rate for a lease — commonly a
percentage of one month's rent, sometimes a flat fee, frequently with a temporary
bonus on top. We want that number per property, agnostic of state and city.

## Is there a central database?

**No authoritative one.** Commission is a private contract term between the
property and the broker, and it moves week to week with concessions. Three real
sources exist, none of them complete:

1. **NAAL Commission Directory** (locatorcommission.com) — properties post
   commission terms, registration instructions, vendor compliance requirements
   and invoice procedures in writing. Free to post, free for locators and
   approved locating platforms to read. Built as locating became a licensed
   activity in all 50 states, so it is nationally uniform by design. Opt-in, so
   coverage is only as good as the properties that bothered.

2. **ALN Apartment Data** — nationwide, per-property, subscription. Primary
   research on every qualifying property out of two research call centers
   (Dallas/Fort Worth and Mayfield, Kentucky). Their own material notes that
   properties paying locator commissions are refreshed on the normal cycle and
   non-paying ones less often, which is a survey floor triaging its queue.

3. **Smart Apartment Data** — nationwide, subscription, and the more interesting
   model. They run a weekly market-survey portal: the property enters its own
   rents, occupancy, concessions and commission, in exchange for a comp report
   showing where it sits against its competitive set. The supply side does the
   data entry because the report back is worth more than the data handed over.
   They also run locator invoicing, which means they observe the commission that
   was actually *paid* on every lease flowing through the platform — not just the
   one that was posted.

Neither vendor solved "collect commission from 100,000 properties." One built a
call center; the other built a two-sided market. The moat in both cases is the
update loop, not the data — a snapshot is reproducible by anyone.

## Why this is not the fifty-state statute problem

Worth stating, because the shapes look similar and are not:

| | Statutes | Commission |
| --- | --- | --- |
| Publisher | 50 sovereign authorities, no join key | Management companies — commercial counterparties who want leads |
| Schema | Bespoke per jurisdiction | Uniform; the same five fields everywhere |
| Completeness | Mandatory — a missing state is a broken product | Not required; only properties inside a client's search radius matter |
| Site platforms | One per state | Yardi / RealPage / Entrata / ResMan cover most of the market |
| Will the source answer a question? | Never | Yes, within the hour, because being off the send list costs them leases |

The long tail collapses at the management company, and commission policy is set
there, not per property. That is the same inheritance the two-card model already
implements: a durable portfolio rate on the master card, a volatile property-level
bonus overriding it on the local card, with an expiry date.

## Decision

The operator already holds a Smart Apartment Data subscription and an existing
property inventory. So:

- **Seed from the existing subscription and inventory** rather than crawling the
  open web for a starting set.
- **Poll politely and continuously, looking only for the delta** — commission and
  bonus changes — rather than re-pulling a full corpus.
- Treat that as one `discovered` source among several, stamped with provenance,
  never as truth that overrides the operator's own records.

Two things to keep in view when this gets built:

**Terms of service.** Automated extraction from a subscription platform is a
contract question, not a technical one, and it lands on the account holder. It
becomes a materially larger question if this tool is ever sold. Vendors of this
kind normally sell an export or a feed; asking for one is cheaper than the
exposure. Keep licensed-feed records tagged by source so they can be excluded
from anything that ships.

**Posted is not paid.** The recorded rate should never be the last word. When a
lease pays out, the amount received either confirms the term or contradicts it —
the same traffic-driven verification the contact cards already use, applied to
money. A property that posts 100% and pays 75% at day 60 is exactly the fact no
directory will ever hold.

## The record, when it is built

Hung on the property node, resolving up the tree like contacts do:

- basis (percent of one month's rent / flat fee / percent of lease value)
- amount, and the lease-term qualifier — six-month and twelve-month rates differ
- effective from, **expires on** — bonuses expire; omitting this is what makes
  commission data quietly wrong
- **registration rule and guest-card window** — first-class, not a note. A 125%
  commission forfeited because the client walked in unregistered is 0%.
- invoice procedure and payment terms
- source, provenance reference, `seenAt`, `verifiedAt`

Two freshness clocks, as elsewhere: a published portfolio rate is durable, a
bonus is volatile and should go stale in days.

## Routes, in priority order

1. The operator's own inbox and DMs — signed referral agreements and the weekly
   bonus blasts. Ground truth, reflects the negotiated rate rather than the
   published one, already legally theirs, and the lead ingestor's archive reader
   already handles that shape.
2. The subscription seed and its delta (above).
3. The management company's realtor / locator / broker referral page — published,
   predictable paths, one crawl target per company rather than per property.
4. The property's own site or listing page.
5. Ask. The reply engine can send the question, and the written answer becomes
   the record.
