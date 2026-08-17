'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Field, Note, Shell, Slider, TextArea } from '@/components/ui';
import { newId, saveDraft } from '@/lib/db';
import { AUDITION_VOICES, DEFAULT_VOICE } from '@/lib/voices';
import { getApiKey, setApiKey, testApiKey } from '@/lib/gemini/browser';
import { asset } from '@/lib/paths';
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

  // Only the goal itself is required. The follow-ups sharpen the writing when answered and
  // are simply skipped when they are not — the prompt is built from whatever is present.
  const complete = goals.filter((g) => g.text.trim());
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

      {step === 2 && <ApiKeyStep />}

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
            Writing the script takes about a minute. Making the audio afterwards takes a few
            more — the voice is generated a passage at a time, then the hour is assembled and
            encoded here in your browser. Keep the tab open while it runs.
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

      <Field label="What do I want to work on?" hint="Your words, not tidy ones. This is the only one that is required.">
        <TextArea
          value={goal.text}
          onChange={(v) => onChange({ text: v })}
          rows={2}
          placeholder="Get to bed before one and up at six without four alarms"
        />
      </Field>

      <Field
        label="Why does this matter to me?"
        hint="Optional. What it is in service of — it becomes the lines about what you value."
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
        hint="Optional. Be concrete — a time, a place, a feeling. It becomes the lines about the moment it gets hard."
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
        hint="Optional, and worth answering — your own evidence is what stops a line sounding like a lie."
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

/**
 * Your own API key, kept on your own device.
 *
 * The app is static files with no server, so there is nowhere for a shared key to live and
 * nothing to proxy through. The browser calls Google directly with this key. It is written
 * to this browser's localStorage and sent to exactly one place: Google's API. It is not in
 * the page source, not in the repository, and not on any server of ours — there is no server.
 */
function ApiKeyStep() {
  // Lazy initial state rather than an effect: localStorage is only touched on the first
  // client render, which is exactly when this component first exists.
  const [key, setKey] = useState(() => (typeof window === 'undefined' ? '' : getApiKey()));
  const [state, setState] = useState<'idle' | 'checking' | 'ok' | 'bad'>('idle');
  const [message, setMessage] = useState('');

  async function check() {
    if (!key.trim()) return;
    setApiKey(key);
    setState('checking');
    const res = await testApiKey(key);
    if (res.ok) {
      setState('ok');
      setMessage('');
    } else {
      setState('bad');
      setMessage(res.message);
    }
  }

  return (
    <div className="mb-8">
      <Field
        label="Your Gemini API key"
        hint="Stored in this browser only. It goes straight to Google and nowhere else — this app has no server to send it to."
      >
        <input
          type="password"
          value={key}
          autoComplete="off"
          spellCheck={false}
          placeholder="AI…"
          onChange={(e) => {
            setKey(e.target.value);
            setState('idle');
          }}
          onBlur={check}
          className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-600 focus:border-ink-500 focus:outline-none"
        />
      </Field>
      <div className="mt-2 text-xs">
        {state === 'checking' && <span className="text-ink-500">Checking…</span>}
        {state === 'ok' && <span className="text-ink-400">Key works. Saved on this device.</span>}
        {state === 'bad' && <span className="text-warm-300">{message}</span>}
        {state === 'idle' && (
          <span className="text-ink-500">
            Get one free at{' '}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
              className="underline decoration-ink-600 hover:text-ink-300"
            >
              aistudio.google.com/apikey
            </a>
            .
          </span>
        )}
      </div>
    </div>
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
  // One element for every audition, so starting a new sample stops the old one instead of
  // layering two voices over each other, and so a sample can be stopped at all.
  const previewRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetch(asset('/auditions/index.json'))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAvailable(d ? d.voices.map((v: { voice: string }) => v.voice) : []))
      .catch(() => setAvailable([]));
  }, []);

  function stopPreview() {
    const el = previewRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setPlaying(null);
  }

  function audition(name: string) {
    // Second press on the same voice stops it; pressing another voice switches to it.
    if (playing === name) {
      stopPreview();
      return;
    }
    stopPreview();
    const el = previewRef.current ?? new Audio();
    previewRef.current = el;
    el.src = asset(`/auditions/${name}.m4a`);
    el.onended = () => setPlaying(null);
    setPlaying(name);
    el.play().catch(() => setPlaying(null));
  }

  // Leaving the step should not leave a voice talking.
  useEffect(() => () => {
    previewRef.current?.pause();
    previewRef.current = null;
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-sm text-ink-300">Voice</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-400">
          Every female-presenting voice the API offers, reading the same passage. Press play to
          hear one, press again to stop it, or press another to switch straight to that one.
          The default is the warmest and lowest-energy of them.
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
                <button
                  onClick={() => audition(v.name)}
                  disabled={!has}
                  aria-label={playing === v.name ? `Stop ${v.name}` : `Play ${v.name}`}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-ink-700 text-ink-300 disabled:opacity-30"
                >
                  {playing === v.name ? (
                    <span className="flex gap-1">
                      <span className="block h-3.5 w-1 rounded-sm bg-ink-300" />
                      <span className="block h-3.5 w-1 rounded-sm bg-ink-300" />
                    </span>
                  ) : (
                    <span
                      className="ml-0.5 block h-0 w-0 border-y-[7px] border-l-[11px] border-y-transparent"
                      style={{ borderLeftColor: 'var(--color-ink-300)' }}
                    />
                  )}
                </button>
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
