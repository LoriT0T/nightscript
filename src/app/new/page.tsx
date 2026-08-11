'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Field, Note, Shell, Slider, TextArea } from '@/components/ui';
import { newId, saveDraft } from '@/lib/db';
import { AUDITION_VOICES, DEFAULT_VOICE } from '@/lib/voices';
import type { Goal, Intake, TrackSettings } from '@/lib/types';

/**
 * Guided intake. Never a blank textarea: each question exists because a specific framing
 * needs its answer — the "why" feeds values lines, the obstacle feeds implementation
 * intentions, the past moment feeds evidence lines, and the rating decides which framings
 * are allowed at all (docs/AFFIRMATION-DESIGN.md §2).
 *
 * The prompts here are phrased interrogatively on purpose. That form is motivating when
 * someone is awake and deliberating, which is exactly the situation intake is — and it is
 * the one place it belongs, since it is banned from the track itself (§9a).
 */

const emptyGoal = (): Goal => ({
  id: newId(),
  text: '',
  why: '',
  obstacle: '',
  evidence: '',
  believability: 5,
  weight: 2,
  sensitive: false,
});

const STEPS = ['What do I want to work on?', 'The voice', 'Ready'] as const;

export default function NewTrackPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [goals, setGoals] = useState<Goal[]>([emptyGoal()]);
  const [note, setNote] = useState('');
  const [settings, setSettings] = useState<TrackSettings>({
    voice: DEFAULT_VOICE,
    bed: 'pink',
    bedLevelDb: -34,
    minutes: 60,
  });
  const [saving, setSaving] = useState(false);

  const update = (id: string, patch: Partial<Goal>) =>
    setGoals((gs) => gs.map((g) => (g.id === id ? { ...g, ...patch } : g)));

  const complete = goals.filter((g) => g.text.trim() && g.why.trim());
  const canContinue = complete.length > 0;

  async function start() {
    setSaving(true);
    const intake: Intake = { goals: complete, note: note.trim() || undefined };
    const id = newId();
    await saveDraft({
      id,
      name: complete[0].text.slice(0, 40) || 'Untitled',
      updatedAt: Date.now(),
      intake,
      settings,
    });
    router.push(`/review?d=${id}`);
  }

  return (
    <Shell title={STEPS[step]} back={{ href: '/', label: 'Library' }}>
      {step === 0 && (
        <div className="space-y-10">
          {goals.map((g, i) => (
            <GoalForm
              key={g.id}
              goal={g}
              index={i}
              onChange={(p) => update(g.id, p)}
              onRemove={goals.length > 1 ? () => setGoals((gs) => gs.filter((x) => x.id !== g.id)) : undefined}
            />
          ))}

          <div className="flex items-center gap-3">
            <Button onClick={() => setGoals((gs) => [...gs, emptyGoal()])}>Add another goal</Button>
            {goals.length > 1 && (
              <span className="text-xs text-ink-400">
                Time is split by the weight sliders above.
              </span>
            )}
          </div>

          <Field
            label="Anything else the writer should know?"
            hint="Optional. Tone, things to avoid, what you cannot stand hearing."
          >
            <TextArea value={note} onChange={setNote} rows={3} />
          </Field>
        </div>
      )}

      {step === 1 && <VoiceStep settings={settings} onChange={setSettings} />}

      {step === 2 && (
        <div className="space-y-6">
          <div className="space-y-2 text-sm leading-relaxed text-ink-300">
            <p>
              {complete.length} goal{complete.length === 1 ? '' : 's'}, {settings.minutes} minutes,{' '}
              {settings.voice}, {settings.bed === 'none' ? 'no bed' : `${settings.bed} bed`}.
            </p>
            <p className="text-ink-400">
              Next you get the full written script. Nothing is spoken until you have read it and
              said yes — an hour of audio from a script you have not read is the expensive
              mistake.
            </p>
          </div>
          <Note>
            Writing the script takes about a minute. Generating the audio afterwards takes
            roughly ten, most of it spent waiting out the API rate limit.
          </Note>
          <Button variant="primary" onClick={start} disabled={saving}>
            {saving ? 'Starting…' : 'Write the script'}
          </Button>
        </div>
      )}

      <div className="mt-12 flex items-center justify-between border-t border-ink-800 pt-6">
        <Button variant="quiet" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          Back
        </Button>
        <span className="text-xs text-ink-500">
          {step + 1} / {STEPS.length}
        </span>
        <Button
          onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
          disabled={step === STEPS.length - 1 || !canContinue}
        >
          Next
        </Button>
      </div>
    </Shell>
  );
}

function GoalForm({
  goal,
  index,
  onChange,
  onRemove,
}: {
  goal: Goal;
  index: number;
  onChange: (patch: Partial<Goal>) => void;
  onRemove?: () => void;
}) {
  return (
    <section className="space-y-5 rounded-xl border border-ink-800 bg-ink-900/50 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm text-ink-300">Goal {index + 1}</h2>
        {onRemove && (
          <Button variant="quiet" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>

      <Field label="What do I want to work on?" hint="Your words, not tidy ones.">
        <TextArea
          value={goal.text}
          onChange={(v) => onChange({ text: v })}
          rows={2}
          placeholder="Get to bed before one and up at six without four alarms"
        />
      </Field>

      <Field
        label="Why does this matter to me?"
        hint="What it is in service of. This becomes the lines about what you value, which work even on nights when nothing else lands."
      >
        <TextArea
          value={goal.why}
          onChange={(v) => onChange({ why: v })}
          rows={2}
          placeholder="Everything else I care about runs on whether I slept"
        />
      </Field>

      <Field
        label="What specifically gets in the way?"
        hint="Be concrete — a time, a place, a feeling. This becomes the 'when X, I do Y' lines, which are the part with the strongest evidence behind them."
      >
        <TextArea
          value={goal.obstacle}
          onChange={(v) => onChange({ obstacle: v })}
          rows={2}
          placeholder="At midnight I get a second wind and start something new"
        />
      </Field>

      <Field
        label="When did I handle this well before?"
        hint="Any time at all, however small. Your own evidence is what stops a line sounding like a lie."
      >
        <TextArea
          value={goal.evidence}
          onChange={(v) => onChange({ evidence: v })}
          rows={2}
          placeholder="During exam week in May I was up at six every day for nine days"
        />
      </Field>

      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-ink-300">How true does this already feel?</span>
          <span className="text-sm tabular-nums text-ink-200">{goal.believability} / 10</span>
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-400">
          Not how much you want it — how true it feels right now. Low is fine and it is not a
          failing. It changes how the lines get written, not whether they get written.
        </p>
        <div className="mt-3">
          <Slider value={goal.believability} onChange={(v) => onChange({ believability: v })} />
        </div>
        {goal.believability < 4 && (
          <p className="mt-2 text-xs leading-relaxed text-warm-300">
            Below 4, so this goal will only be written as something underway, as
            self-compassion, as what you value, or as a specific plan. No flat claims — those
            measurably make things worse when you do not believe them yet.
          </p>
        )}
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-ink-300">How much of the hour should this get?</span>
          <span className="text-sm tabular-nums text-ink-200">{goal.weight}</span>
        </div>
        <div className="mt-3">
          <Slider value={goal.weight} onChange={(v) => onChange({ weight: v })} min={1} max={5} />
        </div>
      </div>

      <label className="flex items-start gap-3 text-sm text-ink-300">
        <input
          type="checkbox"
          checked={goal.sensitive}
          onChange={(e) => onChange({ sensitive: e.target.checked })}
          className="mt-1 h-4 w-4 accent-ink-500"
        />
        <span>
          This one touches addiction or mental health.
          <span className="mt-0.5 block text-xs leading-relaxed text-ink-400">
            Switches to urge-surfing and specific-plan framing, and blocks shame language,
            &ldquo;never again&rdquo; absolutes, and anything that treats a bad night as
            failure. See <Link href="/about" className="underline decoration-ink-600">about</Link>.
          </span>
        </span>
      </label>
    </section>
  );
}

function VoiceStep({
  settings,
  onChange,
}: {
  settings: TrackSettings;
  onChange: (s: TrackSettings) => void;
}) {
  const [available, setAvailable] = useState<string[] | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    fetch('/auditions/index.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAvailable(d ? d.voices.map((v: { voice: string }) => v.voice) : []))
      .catch(() => setAvailable([]));
  }, []);

  function audition(name: string) {
    const el = new Audio(`/auditions/${name}.m4a`);
    setPlaying(name);
    el.onended = () => setPlaying(null);
    el.play().catch(() => setPlaying(null));
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-sm text-ink-300">Voice</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-400">
          Every female-presenting voice the API offers, reading the same passage. Listen rather
          than take my word for it. The default is the warmest and lowest-energy of them.
        </p>
        <ul className="mt-4 space-y-1">
          {AUDITION_VOICES.map((v) => {
            const has = available === null || available.includes(v.name);
            const selected = settings.voice === v.name;
            return (
              <li
                key={v.name}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
                  selected ? 'border-ink-500 bg-ink-800' : 'border-ink-800 bg-ink-900/40'
                }`}
              >
                <button
                  onClick={() => onChange({ ...settings, voice: v.name })}
                  className="flex-1 text-left"
                >
                  <span className="text-sm text-ink-100">{v.name}</span>
                  <span className="ml-2 text-xs text-ink-400">{v.descriptor}</span>
                  {v.nightRank === 1 && <span className="ml-2 text-xs text-warm-300">default</span>}
                  {v.note && (
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{v.note}</span>
                  )}
                </button>
                <Button variant="quiet" onClick={() => audition(v.name)} disabled={!has}>
                  {playing === v.name ? 'playing' : has ? 'hear it' : '—'}
                </Button>
              </li>
            );
          })}
        </ul>
        {available?.length === 0 && (
          <p className="mt-3 text-xs text-warm-300">
            No auditions generated yet. Run <code className="text-ink-300">npx tsx scripts/audition.ts</code>{' '}
            once and they appear here.
          </p>
        )}
      </div>

      <div>
        <h2 className="text-sm text-ink-300">Under the voice</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-400">
          A very quiet noise bed, to mask the house rather than to do anything to your brain.
          Generated locally; nothing streams.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(['pink', 'brown', 'rain', 'none'] as const).map((b) => (
            <button
              key={b}
              onClick={() => onChange({ ...settings, bed: b })}
              className={`rounded-lg border px-3 py-2 text-sm ${
                settings.bed === b
                  ? 'border-ink-500 bg-ink-700 text-ink-100'
                  : 'border-ink-800 bg-ink-900 text-ink-300'
              }`}
            >
              {b === 'rain' ? 'rain (synthesized)' : b}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-ink-300">Length</span>
          <span className="text-sm tabular-nums text-ink-200">{settings.minutes} min</span>
        </div>
        <div className="mt-3">
          <Slider
            value={settings.minutes}
            onChange={(v) => onChange({ ...settings, minutes: v })}
            min={10}
            max={90}
            step={5}
          />
        </div>
        <p className="mt-2 text-xs text-ink-400">
          The shape stays the same at any length — arrival, downshift, core, second pass,
          dissolution, fade — it just compresses.
        </p>
      </div>
    </div>
  );
}
