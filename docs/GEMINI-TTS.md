# Gemini TTS — verified interface notes

**Checked against the live API and live docs on 2026-08-11.**
Everything below marked ✅ VERIFIED was confirmed by an actual HTTP call from this machine on
that date. Items marked 📄 DOCS were read from the live documentation but not independently
exercised. Items marked ❌ WRONG IN DOCS are places where the published documentation does not
match what the API actually returns — code in this repo follows the observed behaviour.

Sources:
- <https://ai.google.dev/gemini-api/docs/speech-generation>
- <https://ai.google.dev/gemini-api/docs/interactions/speech-generation>
- <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-tts-preview>
- <https://ai.google.dev/gemini-api/docs/rate-limits>

---

## 1. Model

✅ VERIFIED `gemini-3.1-flash-tts-preview` — accepted and returns audio.

📄 DOCS other TTS models: `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts`.
Both are single- and multi-speaker capable. 3.1 is the one with the expressive audio tags and
streaming, so it is what this project uses.

📄 DOCS token limits for `gemini-3.1-flash-tts-preview`: **input 8,192 tokens**, **output
16,384 tokens**. The speech-generation guide separately says "a TTS session has a context
window limit of 32k tokens" — these two numbers disagree. **The 8,192 input limit is the
tighter one and is the one this project designs to.** In practice our chunks are ~120–220
words (≈ 200–350 tokens), far inside either limit; the real chunk-size driver is prosody drift,
not context (see §7).

Observed output token rate: ✅ a 1.92 s utterance cost 62 audio output tokens ⇒ **≈ 32 audio
tokens per second of speech**. The 16,384 output-token ceiling therefore corresponds to roughly
**8.5 minutes of audio per single request**. We deliberately use far less than that.

## 2. Endpoint and headers

✅ VERIFIED

```
POST https://generativelanguage.googleapis.com/v1beta/interactions
x-goog-api-key: $GEMINI_API_KEY
Content-Type: application/json
Api-Revision: 2026-05-20
```

The `Api-Revision` header is documented as required for streaming. ✅ Sending it on
non-streaming requests is accepted and is what this project always does, so that one code path
serves both.

## 3. Request shape

✅ VERIFIED (single speaker):

```json
{
  "model": "gemini-3.1-flash-tts-preview",
  "input": "Say this slowly and warmly: your shoulders can be heavy now.",
  "response_format": { "type": "audio" },
  "generation_config": { "speech_config": [{ "voice": "Sulafat" }] }
}
```

📄 DOCS multi-speaker (unused here — this app is one voice by design):

```json
"generation_config": { "speech_config": [
  { "speaker": "Joe",  "voice": "Kore" },
  { "speaker": "Jane", "voice": "Puck" }
]}
```

📄 DOCS streaming: add `"stream": true`; events arrive as
`{ "event_type": "step.delta", "delta": { "type": "audio", "data": "<base64>" } }`.
Streaming is supported on 3.1+. **This project does not stream** — we cache whole chunks by
content hash, so a partial stream has no value to us and non-streaming is simpler to retry.

## 4. Response shape — ❌ THE DOCS ARE WRONG HERE

The published guide says audio comes back as:

```json
{ "output_audio": { "data": "base64..." } }
```

✅ VERIFIED That field **does not exist** in the actual response at `Api-Revision: 2026-05-20`.
The real response is:

```json
{
  "id": "v1_Ch...",
  "status": "completed",
  "object": "interaction",
  "model": "gemini-3.1-flash-tts-preview",
  "created": "2026-08-11T10:24:14Z",
  "updated": "2026-08-11T10:24:14Z",
  "service_tier": "standard",
  "usage": {
    "total_tokens": 72,
    "total_input_tokens": 10,
    "total_output_tokens": 62,
    "input_tokens_by_modality":  [{ "modality": "text",  "tokens": 10 }],
    "output_tokens_by_modality": [{ "modality": "audio", "tokens": 62 }],
    "total_cached_tokens": 0, "total_tool_use_tokens": 0, "total_thought_tokens": 0,
    "raw_prompt_token": 283
  },
  "steps": [
    {
      "type": "model_output",
      "content": [
        {
          "type": "audio",
          "data": "<base64>",
          "mime_type": "audio/l16; rate=24000; channels=1",
          "channels": 1,
          "sample_rate": 24000
        }
      ]
    }
  ]
}
```

Audio lives at `steps[].content[]` where `content[i].type === "audio"`.
`src/lib/gemini/tts.ts` reads that path and falls back to `output_audio.data` only if the
documented field ever appears, so it survives either shape.

## 5. Audio format

✅ VERIFIED `mime_type: "audio/l16; rate=24000; channels=1"` — **raw headerless PCM**,
signed 16-bit little-endian, 24 kHz, mono. Base64 encoded.

There is no RIFF header in the payload. It must be written by us:
44-byte canonical WAV header, `audioFormat = 1`, `numChannels = 1`, `sampleRate = 24000`,
`bitsPerSample = 16`, `byteRate = 48000`, `blockAlign = 2`. Implemented in
`src/lib/gemini/wav.ts`. Playing the base64 payload directly, or writing it to `.wav` without
the header, produces either silence or a burst of noise.

## 6. Rate limits — ✅ VERIFIED, and this is the real constraint

Neither the rate-limits page nor the model page states TTS limits; they defer to the AI Studio
dashboard. The API itself does state them, in the 429 body:

```
Quota exceeded for metric:
generativelanguage.googleapis.com/generate_content_free_tier_requests,
limit: 3, model: gemini-3.1-flash-tts
Please retry in 19.347400292s.
```

**Free tier limit 1: 3 requests per minute for `gemini-3.1-flash-tts`.** The 429 body carries a
`Please retry in <n>s` string; `tts.ts` parses that number and honours it rather than guessing a
backoff.

✅ VERIFIED **Free tier limit 2: there is a second, much harder cap of about 10 requests** on the
same metric, which surfaces only after the first is satisfied:

```
Quota exceeded for metric:
generativelanguage.googleapis.com/generate_content_free_tier_requests,
limit: 10, model: gemini-3.1-flash-tts
```

Same metric name, different `limit` value — the API reports whichever bucket you are currently
against. The 10 is almost certainly per day. **This is the binding constraint on the whole
project**, because a fresh 60-minute track needs ~14 requests: on the free tier a single hour
cannot be rendered from scratch on `gemini-3.1-flash-tts` in one day.

✅ VERIFIED **`gemini-2.5-flash-preview-tts` draws on a separate quota bucket** and still worked
after 3.1 was exhausted. It takes the identical request shape, returns the identical response
shape, and accepts the same natural-language style prompt. Its mime string differs cosmetically
(`audio/L16;codec=pcm;rate=24000` vs `audio/l16; rate=24000; channels=1`) but the payload is the
same 24 kHz mono s16le PCM. It does **not** have 3.1's expressive audio tags or streaming;
neither matters here, since the only tags we would use are ones the style preamble already
covers in words.

`src/lib/pipeline.ts` therefore picks the model **once, before the first chunk**, by trying the
primary on chunk 1 with a short retry budget and falling back on a persistent quota error.
Switching models partway would put an audible seam in the middle of the hour, so the choice is
made up front and applies to every chunk. `gemini-2.5-pro-preview-tts` was also quota-blocked
and is not used.

Also ✅ VERIFIED: `gemini-3.1-pro-preview` has a free-tier quota of **literally 0** requests
(`limit: 0`), so script writing uses `gemini-3.6-flash`, which works.

✅ VERIFIED **On the PAID tier there is still a hard daily cap, and it is per model:**

```
Quota exceeded for metric:
generativelanguage.googleapis.com/generate_requests_per_model_per_day,
limit: 100, model: gemini-3.1-flash-tts
Please retry in 5h46m13s.
```

**100 TTS requests per day per model**, with billing enabled. A 60-minute track costs ~20–22
requests, so roughly four fresh hours a day — and the cap is the reason chunk caching is not a
nicety. It is also why `CHUNK_TARGET_WORDS` is left where it is: chunk text is the cache key,
so changing it silently invalidates every second of already-generated speech.

The reported `retry in` is honoured by the retry logic, so a run that hits the cap waits rather
than failing outright — but nothing will move for hours, so the app surfaces the message.

## 6a. CORS — what a browser is allowed to send

✅ VERIFIED 2026-08-11, from a real browser on `https://lorit0t.github.io`.

The app is now static and calls this API directly from the page, so its CORS policy is
load-bearing. Preflight from a `github.io` origin:

```
access-control-allow-origin: https://lorit0t.github.io
access-control-allow-methods: DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT
access-control-allow-headers: content-type,x-goog-api-key
access-control-max-age: 3600
```

Two consequences:

1. **Browser calls are permitted.** A live `fetch` from that origin returns an HTTP status
   (400 for a bad key) rather than a network error, which is the proof that CORS is not in
   the way.
2. **Only `content-type` and `x-goog-api-key` may be sent.** A preflight that additionally
   asked for `api-revision` returned **403**. Since §2 records `Api-Revision: 2026-05-20` as
   required for streaming, this looked like it ruled out static hosting entirely.
   ✅ It does not: **both the streaming and non-streaming endpoints work with the header
   omitted.** Adding any custom header here will break the app in the browser while
   continuing to work from the CLI — re-run a preflight before adding one.

Consequence for a 60-minute track: ~20 requests, so a full hour costs a few minutes of wall
clock. Chunk caching by content hash (§7) is what keeps an edit to one line from re-spending
the whole hour — and, against a 100-per-day cap, most of the day.

## 7. Prompting, tags, and chunking

📄 DOCS Style is directed by **natural language inside the `input` string**, not by a separate
field and not by SSML. There is no SSML support. The docs' "director's notes" framing is
Style / Pacing / Accent, and explicitly rewards specificity.

📄 DOCS Inline audio tags, confirmed list:
`[amazed] [crying] [curious] [excited] [sighs] [gasp] [giggles] [laughs] [mischievously]
[panicked] [sarcastic] [serious] [shouting] [tired] [trembling] [whispers]`
Custom free-text tags also work, e.g. `[very slow]`, `[like a cartoon dog]`,
`[sarcastically, one painfully slow word at a time]`.

✅ VERIFIED `[whispers]` inline is accepted and audibly changes delivery.

⚠️ Of that list only `[whispers]`, `[sighs]`, `[tired]` and custom slow/soft tags are usable
here. Everything else raises energy, which §3 of the brief forbids after minute four.

✅ VERIFIED **content filtering is real and is triggered by sleep-suggestion phrasing.** The
first style preamble drafted for this project —

> "Read this slowly and warmly, close to the microphone, as if speaking to someone already half
> asleep. Let every sentence fall at the end. [whispers] You do not have to stay awake for this."

— returned **HTTP 400 `content_blocked`**, "Request blocked for an unspecified policy reason."
Individually rephrased variants of the same instruction passed. The blocked text reads like
hypnotic induction, which is the most likely trigger. The production preamble in
`src/lib/gemini/style.ts` is therefore worded to describe *vocal delivery only* and never to
address the listener's consciousness or sleep state. Any change to that preamble must be
re-tested against the live API before shipping.

**Chunking policy used here** (`src/lib/script/plan.ts`):
- Chunk on affirmation boundaries, never mid-sentence.
- Target 120–220 spoken words (~60–110 s of audio) per request — one to two orders of magnitude
  inside the context limit. The limit is chosen for prosody stability, not for tokens: longer
  chunks let the model accelerate and brighten toward the end.
- The identical style preamble is prepended to **every** chunk so the voice does not drift
  between requests.
- Every chunk is cached by SHA-256 of `preamble + voice + model + text`, so re-generating a
  script after editing one line re-spends only the chunks that actually changed.

## 8. Pause handling

The model's own inter-sentence pauses are short and not controllable to the precision this
project needs (3 s early, growing to 8 s by the final third). Rather than trying to make the
model hold a pause, we generate several affirmations per request and then **re-time them**:
`ffmpeg silencedetect` splits the returned audio at gaps ≥ 0.35 s, and the pipeline reassembles
the pieces with exactly the silence the arc calls for. If the number of detected pieces does not
match the number of lines sent, the pipeline falls back to using the chunk whole and spacing at
chunk level — degraded but never broken. See `src/lib/audio/assemble.ts`.

## 9. Cost / key handling

The API key is read from `process.env.GEMINI_API_KEY` on the server only. It is never sent to
the browser, never written into this repo, and never logged. `.env*` is gitignored by the
Next.js scaffold. See the README for how to supply it.
