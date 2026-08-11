# Nightscript

An hour of quiet, written for you, to fall asleep to.

You describe what you want to work on. It writes a personal affirmation script you read and
edit before a single word is spoken, then produces a sixty-minute track in a calm female
voice, shaped to descend from the first minute to the last so that if you are asleep by
minute twelve nothing later wakes you.

Two documents carry the reasoning and should be read before changing anything:

- **[docs/AFFIRMATION-DESIGN.md](docs/AFFIRMATION-DESIGN.md)** — why the lines are worded the
  way they are, with sources. Every rule in the validator traces to a numbered section here,
  including the three places the evidence contradicts the obvious design and what was done
  about it.
- **[docs/GEMINI-TTS.md](docs/GEMINI-TTS.md)** — the TTS interface as actually verified against
  the live API on 2026-08-11, including the places the published docs are wrong.

---

## Running it

```bash
npm install
```

ffmpeg is required and is not bundled:

```bash
brew install ffmpeg
```

Supply the API key as an environment variable in the shell that runs the server. It is never
written into this repo, and `.env*` is gitignored:

```bash
export GEMINI_API_KEY='your-key-here'
```

```bash
npm run dev
```

### Generate the voice auditions once

Every female-presenting voice reads the same passage so you pick by ear rather than by
descriptor. Output goes to `public/auditions/` and the picker in the app reads it from there.

```bash
npx tsx scripts/audition.ts
```

At three requests per minute this takes about five minutes for the full set. It is cached, so
a re-run costs nothing.

### Generate a track from the command line

The app's API route and this script run the same pipeline. The CLI exists so an hour-long
generation can be driven and measured without holding a browser tab open.

```bash
npx tsx scripts/generate-track.ts out/intake.json --minutes 60 --voice Sulafat --bed pink
```

```bash
npx tsx scripts/generate-track.ts out/intake.json --script-only
```

Useful flags: `--script out/track.script.json` to reuse a written script, `--bed none`,
`--out path/prefix`, `--force` to skip validation.

### Tests

```bash
npm test
```

### Verify the audio pipeline without spending quota

Runs the real timeline, splitter, ffmpeg chain and measurement over a full-length track using
cached audio in place of TTS calls. Proves duration, loudness, peak, level descent and
encoding; does not prove the spoken words are the script's words.

```bash
npx tsx scripts/verify-assembly.ts --minutes 60
```

---

## How it works

```
intake  ─▶  script model  ─▶  validator  ─▶  you read and edit it
                                                    │
                                                    ▼
                              chunks (120–220 words, split on affirmation
                              boundaries, cached by SHA-256)
                                                    │
                                                    ▼
                              Gemini TTS, one call per chunk, identical
                              style preamble on every call
                                                    │
                                                    ▼
                              silence-split back into lines, re-laid against
                              the pause schedule, de-essed, low-passed,
                              tapered, mixed with the bed, normalised
                                                    │
                                                    ▼
                              Opus/WebM + AAC/M4A  ─▶  your IndexedDB
```

**The arc.** Six sections at fixed proportions: arrival (0:00), downshift (4:00), core
(10:00), second pass (35:00), dissolution (50:00), fade (57:00). Pauses grow from 3 s in the
core to about 8 s by the end, and a level taper guarantees the descent in the master
regardless of what the model does — 0 dB until 4:00, then a slide to −6 dB by the end.

**Repetition is free.** The core section is heard three to four times. A repeat reuses the
identical chunk grouping, so its cache key is unchanged and a second cycle costs zero API
requests. Variation across exposures comes from the second pass (the model's softer
re-voicing) and the dissolution fragments, not from re-generating the core wording. This is
what makes a four-exposure hour affordable at three requests a minute.

**Pauses are not the model's.** It cannot hold a seven-second gap reliably. Each chunk is
split back into its lines at the model's own inter-sentence gaps and re-laid against the exact
schedule. If the split does not match the expected line count the pipeline falls back to
spacing at chunk level — degraded, never broken. The count of fallbacks is reported.

## What the server sees

Nothing is stored. There is no account, no database, and no server-side copy of your goals.

- Your intake, script, and finished audio live in this browser's IndexedDB.
- When you generate, the script goes to Google's API to be spoken, and to this app's own
  process to be assembled with ffmpeg. Both copies are deleted as soon as the file reaches
  your browser.
- The generated audio chunks are cached on disk under `.cache/tts/`, keyed by content hash, so
  that editing one line does not re-spend the whole hour. Delete that directory to clear them.
- The API key is read from `process.env` on the server and never sent to the browser.

## What this does not have

No streaks, no badges, no reminders, no notifications, no social features, nothing that turns
a night you did not use it into a failure. It runs at bedtime for someone trying to sleep, and
every retention mechanic is a reason to be awake.

## Known limits

- **Free tier is 3 requests per minute AND about 10 requests per day** on
  `gemini-3.1-flash-tts`. A fresh hour costs about fourteen requests, so **a 60-minute track
  cannot be rendered from scratch on the free tier in a single day.** The pipeline detects the
  exhausted quota before generating anything and switches the whole track to
  `gemini-2.5-flash-preview-tts`, which has a separate bucket — but that model has the same
  daily cap, so two fresh hours in one day needs billing enabled. Cached chunks are free and
  unlimited. See docs/GEMINI-TTS.md §6.
- **The style preamble is content-filtered.** Wording that describes the listener's sleep state
  reads as hypnotic induction and returns HTTP 400. See docs/GEMINI-TTS.md §7 before editing it.
- **The bed is synthesized, not recorded.** "Rain" is band-limited noise shaped to sit where
  rain sits, and is labelled as synthesized in the UI.
