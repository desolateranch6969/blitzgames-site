# Switchboard

The operator console. One interface over every module — the reply queue from the
reply engine, leads and follow-ups from the ingestor, the property rolodex from
the directory.

`switchboard.html` is a single self-contained file: no build step, no
dependencies, no network calls except the Google Fonts stylesheet. Open it in a
browser and it runs. The data in it is illustrative — this is the shape of the
interface, wired to fixtures rather than to the modules.

## Sections

| Section | What it is |
| --- | --- |
| Today | The day in counts: what is waiting, what is overdue, where leads came from |
| Leads | Every lead with its unique ID, its disposition and its extracted criteria |
| Follow-ups | The reminder tracker, keyed to lead IDs, bucketed due / overdue / blocked |
| Reply queue | Drafted replies awaiting approval, each showing the speech acts behind it |
| Properties | The two-card rolodex: local site team, master card inherited from above |
| Intake forms | The client-data form builder, per vertical |
| Sources | Where leads arrive from and the health of each connection |
| Settings | Voice profile, approval mode, retention |

## Layout

| Width | Layout |
| --- | --- |
| ≥ 1080px | Three columns — rail, list, record |
| 760–1080px | Two columns — the rail holds, list and record stack |
| < 760px | One column — the rail becomes a pinned, scrolling tab strip |

Theme follows the operating system. The **Switch theme** control in the rail
overrides it per device and persists in `localStorage`.

## Screenshots

`screenshots/` holds real renders at each target viewport, produced by
`tools/shoot.mjs`:

```
npm i playwright          # once
cd switchboard
node tools/shoot.mjs
```

One thing the script exists to get right: it wraps `switchboard.html` in a full
document with a viewport meta before shooting. Without that, Chromium lays mobile
out at 980px and scales down, which is not what any phone shows.
