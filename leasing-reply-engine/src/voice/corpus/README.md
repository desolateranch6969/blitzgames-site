# Voice corpus

Drop real message samples here, then build a profile from them:

```bash
npm run learn -- --corpus src/voice/corpus/dms.jsonl --id mike --out src/voice/profiles/mike.json
```

Nothing else in the engine changes. Point `VOICE_PROFILE=mike` at the result and
every reply is written in his words.

## Formats

**Paired (best).** One JSON object per line. Pairs give both the phrase bank and
the few-shot examples the model realizer uses:

```json
{"lead": "do you charge anything?", "agent": "nope costs you nothing, the property pays my side"}
{"lead": "im looking for a 2 bed around 1800", "agent": "ok cool 2 bed up to $1,800"}
```

**Unpaired.** Still gives style, tics, and phrases:

```json
{"role": "agent", "text": "let me pull a few and shoot them over"}
```

**Instagram data export.** Download from Instagram (Settings → Your activity →
Download your information → JSON), then point at a `message_1.json`:

```bash
npm run learn -- --ig-export path/to/message_1.json --me "His Display Name" --id mike --out src/voice/profiles/mike.json
```

## How many samples

| Messages | What you get |
|---|---|
| under 50 | A hint. Merged over the baseline; treat the result as a draft. |
| 50-200 | Usable. Style is roughly right, phrase banks are thin in places. |
| 200+ | Good. Style statistics are stable and most speech acts have real wording. |

`learn` prints exactly which speech acts got real examples and which are still
falling back to baseline wording, so there is no guessing about what was covered.

## Before you collect

These are real conversations with real people. Keep the corpus out of version
control (`.gitignore` already excludes `*.jsonl` here), strip names, phone
numbers, and addresses before building a profile, and use only the account
owner's own messages to model his voice.
