# Affirmation design — evidence base

**Compiled 2026-08-11.** Every writing rule enforced by `src/lib/affirmations/validator.ts` and
every instruction in the generation prompt (`src/lib/gemini/script.ts`) traces to a numbered
finding here. Where the evidence contradicts the product brief, §9 says so plainly rather than
quietly complying.

---

## 1. Why generic affirmations fail — the contrast/backfire effect

Wood, Perunovic & Lee (2009), *Psychological Science* 20(7), "Positive Self-Statements: Power
for Some, Peril for Others."

- Participants with **low self-esteem** who repeated "I'm a lovable person" felt **worse** —
  lower mood and lower state self-esteem — than controls who repeated nothing.
- Participants with high self-esteem improved, but only slightly.
- The mechanism is contrast: a statement far outside a person's latitude of acceptance triggers
  active retrieval of disconfirming evidence. The louder the claim, the more counter-evidence it
  recruits.
- **The critical condition for this project:** participants asked to focus on how the statement
  was **both true and not true** did *not* show the backfire. Allowing the contradiction
  outperformed asserting past it.

→ Rule 1: no absolute trait claims. → Rule 2 (PERMITTED AMBIVALENCE) is not a softening nicety;
it is the specific manipulation that removed the harm in the original study.

<https://pubmed.ncbi.nlm.nih.gov/19493324/> ·
<https://journals.sagepub.com/doi/abs/10.1111/j.1467-9280.2009.02370.x>

## 2. Latitude of acceptance → the 1–10 believability gate

The backfire is a function of distance between the claim and current self-concept, not of the
claim's content. So the same sentence is safe for one listener and harmful for another, and the
only way to know is to ask.

→ Intake collects a 1–10 believability rating per goal. Anything **rated below 4 may only be
written as process, self-compassion, values, or implementation-intention framing** — never as a
present-tense state claim. The validator enforces this per-line, using the rating attached to the
line's goal. Ratings are re-asked on regeneration so phrasing can strengthen as belief does.

## 3. Process / becoming framing

Follows directly from §1: "I am learning to X" is not falsifiable against present evidence the
way "I am X" is, so it recruits no counter-evidence. It is also consistent with the incremental
("growth") construal of ability, which is associated with persistence after setbacks rather than
withdrawal (Dweck's implicit theories literature).

→ Required pattern PROCESS.

## 4. Implementation intentions — the pattern that actually changes behaviour

Gollwitzer & Sheeran (2006) meta-analysis: 94 independent tests, >8,000 participants, **d = 0.65**
(95% CI 0.60–0.70) for if-then plans on goal attainment. Sheeran, Listrom & Gollwitzer (2024)
extends this to 642 tests.

Form: *"If \<situation/obstacle\> arises, then I will \<specific response\>."* The effect is
attributed to delegating control to the environmental cue — the situation triggers the response
without requiring deliberation at the moment of temptation, which is exactly the moment
deliberation is unavailable.

This is by a wide margin the best-evidenced element in the whole track. Effect sizes for
affirmation-type interventions (§5, d ≈ 0.41 and often smaller) are not close.

→ Required pattern IMPLEMENTATION INTENT, and the generator is instructed to weight these
heavily rather than treat them as one flavour among seven. They must name a **concrete cue**
(time, place, or sensation) and a **concrete action**.

<https://cancercontrol.cancer.gov/sites/default/files/2020-06/goal_intent_attain.pdf> ·
<https://goalsandprogress.com/implementation-intentions-gollwitzer-how-to/>

## 5. Values affirmation ≠ trait affirmation

Cohen & Sherman (2014), *Annual Review of Psychology*, "The Psychology of Change";
Sherman et al. (2021) review.

- Self-affirmation in the research sense means **writing about a core personal value**, not
  asserting a flattering trait. These are different interventions with different evidence bases,
  and the popular "affirmation" genre conflates them.
- Mechanism: affirming values in *any* domain restores a global sense of self-integrity, which
  reduces defensiveness against threat in the domain that actually hurts. It works by widening
  the self, not by arguing about the threatened trait.
- Meta-analysis in educational settings: **d ≈ 0.41**, small-to-moderate. Effects are largest for
  people under active threat and can be null or negative otherwise.

→ Required pattern VALUES: affirm what the listener cares about ("I care about being someone my
people can rely on"), which is unfalsifiable and self-verifying, rather than a trait they feel
they lack.

<https://www.annualreviews.org/content/journals/10.1146/annurev-psych-010213-115137> ·
<https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10779329/>

## 6. Self-compassion

Neff's work and the associated clinical literature: self-compassion (common humanity + kindness +
mindful awareness of difficulty) predicts lower anxiety/depression and, importantly here, does
**not** require any positive self-evaluation to function. It bypasses the contrast loop in §1
entirely because it makes no claim about the self that can be contradicted — "struggling with
this does not make me broken" is a statement about the meaning of struggle, not about ability.

→ Required pattern SELF-COMPASSION, and the mandated fallback for any goal rated below 4.

## 7. Urge surfing — the addiction and mental-health path

Marlatt's urge-surfing technique; Bowen et al. Mindfulness-Based Relapse Prevention.

- The instruction is to observe the craving as a wave with a beginning, middle and end, and to
  remain in contact with it without acting — explicitly *not* to suppress or fight it.
- MBRP RCT evidence shows meaningful reductions in relapse relative to standard care; a college
  smoking study using urge surfing found roughly a 26% reduction in smoking, about double control.
- Suppression-framed and shame-framed self-talk is the failure mode: "never again" is an absolute
  trait claim (§1) whose first violation invalidates the whole frame, and abstinence-violation
  effect research indicates that framing a lapse as identity failure predicts full relapse.

→ For addiction / mental-health goals the generator is restricted to urge-surfing and
implementation-intention framings; the validator additionally bans "never again", "clean/dirty",
"weak", "willpower", "failure", "relapse" and shame constructions on those goals.
→ The app carries a quiet non-nagging note that this is a personal practice, not treatment, with
a real support link. It does not position itself as therapy or recovery care anywhere.

<https://pmc.ncbi.nlm.nih.gov/articles/PMC5441879/> ·
<https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9567496/>

## 8. Pre-sleep suggestibility and what audio can actually do overnight

This is the weakest link in the chain and is stated honestly rather than oversold.

- **Sleep-learning of new declarative content is not supported.** The "hypnopaedia" claim was
  discredited in the 1950s once EEG could confirm subjects were actually asleep.
- **Targeted memory reactivation (TMR) is supported**, but it is *re-activation of material
  learned while awake*, cued by a sound that was paired with it during learning. Meta-analysis
  across 70+ studies finds a small-to-medium effect on retention. Verbal cues produce stronger
  spindle-power increases than non-verbal cues, suggesting speech is an effective cue type.
- The honest model for this track is therefore: **the pre-sleep window, while still awake, is
  where the content lands** — that is ordinary rehearsal at a time of low distraction and high
  emotional openness — **and anything still playing after sleep onset is at best a familiar cue,
  at worst an arousal risk.** The descending arc in §3 of the brief is built on exactly this: the
  content-bearing minutes are front-loaded into 10:00–35:00, and everything after is designed to
  do no harm rather than to teach.

<https://pmc.ncbi.nlm.nih.gov/articles/PMC11094403/> ·
<https://pmc.ncbi.nlm.nih.gov/articles/PMC10547374/>

## 9. Where the evidence contradicts the brief

**9a. Interrogative self-talk outperforms declarative — but not here.**
Senay, Albarracín & Noguchi (2010), *Psychological Science*: participants primed with "Will I"
rather than "I will" solved more anagrams and reported stronger exercise intentions; the effect
was mediated by intrinsic motivation. On the face of it this contradicts the brief's rule that
every line be declarative and that no line be answerable with "no I'm not".

Resolved in favour of the brief, for three stated reasons, not silently:
1. The paradigm is a **pre-task motivational prime in awake participants**, measured minutes
   later. It is not evidence about an hour of audio at sleep onset.
2. An open question is arousing by construction — it requests cognitive work. §8's whole logic is
   that arousal after minute four is the primary failure mode. A question at minute 40 is a
   wake-up.
3. The finding is a single-lab result of the 2010 vintage and has attracted the usual
   replication concerns; it is not in the same evidentiary class as §4.

→ The interrogative form is **not used in track content**. It is used in the *intake wizard*,
which is awake, deliberate, and pre-task — precisely the paradigm it was tested in. That is where
the "Will I…" framing earns its place.

<https://pubmed.ncbi.nlm.nih.gov/20424090/>

**9b. "-23 LUFS" needs a qualifier the brief does not give.**
EBU R128's −23 LUFS target assumes a calibrated monitoring chain; the audiobook standard (ACX)
sits at −23 to −18 LUFS with peaks under −3 dBTP. Both are *relative* targets — the absolute SPL
in the bedroom is set by the listener's volume knob, and no encoded level can control it. The
WHO night-noise guidance is the number that actually matters physiologically: **under 30 dB(A)
L_Aeq indoors**, with events at 45 dB(A) L_Amax or less already correlating with disturbance;
30–40 dB produces body movements and arousals short of waking. We hit −23 LUFS / −3 dBTP as the
brief specifies (it is a sane, quiet, standards-aligned target and it makes the *internal*
dynamics safe), while noting that "do not exceed the previous minute" is the constraint doing the
real work, because it is the only one independent of playback gain.

**9c. Repetition is a double-edged tool.**
§1's backfire is *produced by repetition* of an unbelievable statement — repetition amplifies
whatever the line already does. The brief's 3–4× cycling of 40–60 core lines is right for
believable, process-framed lines and actively harmful for absolute ones. This is a second,
independent reason the validator must be strict: at 3–4 repetitions, one bad line is heard a
dozen times.

**9d. Volume math checks out, with a caveat.**
35–45 effective words/minute at sleep pacing ⇒ 2,100–2,700 words per hour. Measured against our
own generated audio the *speech-only* rate is ~95–105 wpm (slow but normal); the effective rate
falls into the target band only because roughly 55–60% of the hour is deliberate silence. The
pause schedule is therefore not decoration — it is what makes the word count come out right.

<https://tech.ebu.ch/docs/r/r128.pdf> ·
<https://www.who.int/europe/news-room/fact-sheets/item/noise> ·
<https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5877064/>

## 10. Sleep-audio production norms

- **Loudness**: −23 LUFS integrated, true peak ≤ −3 dBTP (§9b).
- **Monotonic descent**: no minute may exceed the level of the minute before it after 4:00,
  enforced by measurement rather than by intention. **Measured on per-minute *peak*, not
  per-minute RMS.** This distinction turned out to matter: over a track that is more than half
  silence, per-minute RMS mostly reports how much of that particular minute was silence, so it
  swings around a decibel as the pause schedule grows and reports a rise on a track whose
  loudest moments are in fact falling. The loudest moment in a minute is what the sleeping ear
  is actually exposed to. A safety taper (0 dB until 4:00, then linear-in-dB to −6 dB by the
  end) guarantees the descent regardless of what the model does chunk to chunk.
- **Sibilance**: /s/ energy sits at 5–9 kHz, is the most arousing part of speech at low overall
  level, and survives the low-pass unless de-essed. We apply a de-esser then a gentle low-pass at
  10 kHz. Sibilance is the single most common cause of a listener jolting awake mid-track.
- **Frequency content**: a low shelf lift is *not* applied — added low end increases perceived
  loudness for no intelligibility gain. A high-pass at 80 Hz removes rumble the listener cannot
  use.
- **Fades**: the brief's 90-second final fade is well above the ~50 ms threshold at which a level
  change is perceived as an event; a slow fade is not perceived as anything, which is the point.
- **Bed**: pink noise is the choice, not white. Pink noise is used in the slow-oscillation
  literature (Papalambros et al. 2017, *Frontiers in Human Neuroscience*) and, separately, has a
  1/f spectrum that masks intermittent household noise without adding high-frequency energy. Note
  honestly: that study used *phase-locked closed-loop* pulses tied to the listener's own EEG
  upstates and found improved word recall — a continuous open-loop bed is **not** the same
  intervention and should not be claimed to deepen sleep. It is masking, and that is all we claim.
  Ships as a local file; nothing streams.

<https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5340797/>

---

## Rule → evidence traceability

| Rule enforced in code | Source |
|---|---|
| Ban absolute trait claims | §1 Wood et al. 2009 |
| Ban second person, keep first person | brief; consistent with §1 (self-referential processing) |
| Ban wealth / manifestation / cosmic framing | no evidence base; §1 predicts maximal contrast harm |
| Ban superlatives and hype | §1 (magnitude of claim ∝ counter-evidence recruited) |
| PROCESS framing | §3 |
| EVIDENCE-ANCHORED | §1 — reduces distance to latitude of acceptance using the listener's own data |
| SELF-COMPASSION | §6 |
| VALUES | §5 |
| IMPLEMENTATION INTENT (weighted highest) | §4 |
| PERMITTED AMBIVALENCE | §1, the "both true and not true" condition |
| SENSORY / EMBODIED | §8, §10 — arousal reduction rather than content delivery |
| Believability < 4 ⇒ process/compassion only | §2 |
| Addiction goals: urge-surfing, no shame, no "never again" | §7 |
| Content front-loaded 10:00–35:00 | §8 |
| Monotonic level descent, de-ess, 10 kHz low-pass | §10 |
| −23 LUFS / −3 dBTP | §9b |
| Pink-noise bed, masking claim only | §10 |
| Interrogative form in intake only, never in track | §9a |
