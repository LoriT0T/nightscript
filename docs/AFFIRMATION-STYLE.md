# Affirmation style — the "scripting" voice

**Derived 2026-08-12** from four reference tracks supplied by the listener, by measuring their
structure. No wording from them is reproduced here or in the generator; what follows is the
*shape*, described so it can be applied to any topic. Every illustration below is written fresh.

Reference material:
- <https://www.youtube.com/watch?v=vYvscMwcTmo> — first person. This is the one the style is taken from.
- <https://youtu.be/ReNZTmqa3aA>, <https://www.youtube.com/watch?v=WrmFFKrhKQc>,
  <https://www.youtube.com/watch?v=5vxfcIIETBE> — measured, then set aside; see §5.

---

## 1. What was measured

Auto-captions were pulled for all four and analysed for person, tense, unit length, opening
n-grams and vocabulary density.

| | vYvscMwcTmo | the other three |
|---|---|---|
| person | **first** — "I…", "my…" | **second** — "you are…", "you deserve…" |
| `you`/`your` per 1k words | 1.9 | 118–216 |
| `I am`/`I'm` per 1k words | 40.8 | ~0 |
| median unit length | **9 words** | 8–10 words |

Three of the four are not affirmations at all in the grammatical sense — they are guided
second-person narration. Only `vYvscMwcTmo` is a first-person affirmation track, so it is the
model. The others contributed one thing each: unit length, and the confirmation that short lines
are the norm across the genre.

## 2. The structural rules

Unit length: **median 9 words, quartile 7, ninetieth percentile 14.** Nothing long. Measured on
the reference: n=334 units, max 26.

Line forms, in rough order of how often they appear:

1. **Gratitude opener.** The single densest marker in the reference — 51 occurrences of
   gratitude vocabulary in ~3,100 words, most of them opening the line. It varies the
   intensifier rather than the structure: *so* grateful, *really* grateful, *super* grateful.
   → `I'm so grateful that my mornings start early now.`
2. **Present-tense possession.** `I have …` — the thing is spoken as already had.
   → `I have a body that carries me easily.`
3. **Present-tense identity.** `I am a …`, `I am …`. The desired state, asserted flatly.
   → `I am someone who trains four times a week.`
4. **Capability.** `I can …`, `I'm able to …`.
   → `I can lift heavier than I could last month.`
5. **Emotional naming.** `I feel …`, `it feels …`. Names the feeling the state produces, which
   is what the listener is actually reaching for.
   → `It feels good to be this strong.`
6. **Reciprocity and dependability.** `I give and …`, `people can depend on me …`, `I mean a
   lot to …`. The reference leans on this more than expected for a "dream life" track.
7. **Trust / it-works-out.** `I trust …`, `everything works out …`. Short, and used as a
   breather between the denser claims.
8. **Concrete detail, but always attached to a claim.** The reference grounds its lines in real
   objects and moments — but as something the listener *has* or *does*, never as a standalone
   picture. `I ride to work on a bike I paid for outright.` is in style; a line describing the
   bike is not. See §2c, which is the rule this collapsed into.

Sequencing: **anaphora with small mutations.** The same opening runs two to four times with the
object changing, then the form switches. Not a shuffled list of unrelated claims — short streaks.

Tense discipline: **no future tense.** The reference has essentially no `I will`. Everything the
listener wants is spoken in the present, as a description of their life rather than a plan for
it. This is the single biggest departure from the process style below.

## 2a. Repetition — each affirmation said two or three times

The listener's instruction, after hearing a generated track: say each affirmation twice or
three times before moving to the next, adjusting slightly or adding meaning each time.

So the core is not a list of separate claims. It is a small number of affirmations, each stated
two or three times **consecutively**, marked with a shared `clusterId`. Each restatement is a
deepening rather than a synonym swap — more specific, or naming what the thing gives them.

The timeline honours the grouping: the gap **between restatements** is 45% of the scheduled
pause with a 2-second floor, while the full growing pause falls **between clusters**. Without
that, three readings of one thought are heard as three unrelated lines, which defeats the point.

## 2b. No guided relaxation. None.

The reference style is affirmations, and the listener was explicit after hearing a body scan in
a generated track: he does not want it. No jaw, shoulders, hands, chest, breath or limbs. Nothing
sinking, softening, loosening, growing heavy, settling or resting.

This removed the entire body-scan section as a *content* type. The section survives as a *pacing*
stage — the arc still descends in density and grows in pause length — but every line in it is an
affirmation. Enforced by the `body-sensation` rule.

## 2c. Every line is an affirmation about this listener

Two failure modes, both of which shipped before being caught:

- **Scene-setting.** Lines that paint a picture without asserting anything: chrome catching the
  sun, fresh rubber on open road, a bar that feels light. They are broad, they are about nobody,
  and the listener rejected them by name.
- **Generic encouragement** that could appear in anyone's track.

Enforced by `not-an-affirmation`: every line needs a first-person **subject** — `I`, `I'm`,
`I've`, `me` — not merely the possessive `my`, since "cold steel on my palms" has `my` and is
still just a photograph. The one subjectless form allowed is `It feels…`, which is a statement
about the listener's state and is part of the measured style.

`off-topic` additionally warns when a line shares no vocabulary with any stated goal.

## 3. What is kept out, and why it costs nothing

The reference contains **zero** instances of `universe`, `manifest`, `manifestation`,
`abundance`, `vibration`, `frequency`, `attract`, `law of attraction`, `divine`, `energy`, or
`blessed`. Measured, not assumed.

That is a genuinely useful finding: the cosmic register is **not** part of this style. The
reference personifies money and speaks of it plainly and often, but never reaches for the
metaphysics. So the mystical ban in the validator survives intact — it turns out to be
compatible with the style, not opposed to it.

## 4. Relationship to the process style

`docs/AFFIRMATION-DESIGN.md` §1 documents the finding that present-tense claims outside a
listener's latitude of acceptance can lower mood in the person repeating them (Wood, Perunovic &
Lee 2009). The scripting style is made of exactly those claims. The two are in real tension and
this document does not pretend otherwise.

Both are available; `TrackSettings.style` selects between them:

- **`scripting`** (default) — this document. What the listener asked for, twice.
- **`process`** — `docs/AFFIRMATION-DESIGN.md`. "I am learning to…", implementation intentions,
  permitted ambivalence.

The rails that remain on in **both** styles are the ones about harm rather than taste:

| rule | why it stays |
|---|---|
| no second person | it is an affirmation, not narration; also the listener's instruction |
| no questions, no interrogative form | arousing at sleep onset — design doc §9a |
| no exclamation marks | violates the monotonic-descent constraint |
| no mystical / manifestation vocabulary | the reference does not use it either (§3) |
| no shame, no "never again", on addiction & mental-health goals | design doc §7, abstinence-violation effect |
| implementation intentions still need a concrete cue | design doc §4; the pattern is meaningless without one |

Relaxed under `scripting`: the absolute-trait ban, the superlative list, and the
believability-below-4 restriction. Believability still shapes *wording* — a goal rated 2 gets
gratitude and capability forms rather than flat identity assertions — but it no longer forbids
present tense outright.

## 5. Why the other three were set aside

They are second-person guided narration. Copying their structure would have produced a track
that says "you are strong" — which is both against the listener's own brief and a different
product. Their contribution was the unit-length measurement in §2.
