'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Note, Shell } from '@/components/ui';
import { getDraft, openDatabase, saveDraft, saveTrack, newId, type Draft } from '@/lib/db';
import { generateTrack, writeScript as writeScriptApi, type GenerateProgress } from '@/lib/generate';
import { validateScript } from '@/lib/affirmations/validator';
import { generateText } from '@/lib/gemini/browser';
import { acceptRepair, buildRepairPrompt } from '@/lib/gemini/script';
import { ARC, estimateRuntimeSec, formatDuration } from '@/lib/script/plan';
import { PATTERN_LABEL, type Line, type Section, type TrackMeta } from '@/lib/types';

export default function ReviewPage() {
  return (
    <Suspense fallback={<Shell title="Loading…">{null}</Shell>}>
      <Review />
    </Suspense>
  );
}

function Review() {
  const params = useSearchParams();
  const router = useRouter();
  const draftId = params.get('d');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [fraction, setFraction] = useState(0);

  useEffect(() => {
    if (!draftId) return;
    let alive = true;
    void (async () => {
      const opened = await openDatabase();
      if (!alive) return;
      if (!opened.ok) {
        setError(opened.message);
        return;
      }
      const d = await getDraft(draftId);
      if (alive) setDraft(d ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [draftId]);

  const writeScript = useCallback(async (d: Draft) => {
    setWriting(true);
    setError(null);
    try {
      const script = await writeScriptApi(
        d.intake,
        d.settings.minutes,
        setProgress,
        undefined,
        d.settings.style ?? 'scripting',
      );
      const next = { ...d, script };
      setDraft(next);
      await saveDraft(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWriting(false);
    }
  }, []);

  // Write the script once, automatically, when arriving with a fresh draft. Kicked off in a
  // microtask so the first render commits before any state lands.
  useEffect(() => {
    if (!draft || draft.script || writing) return;
    const d = draft;
    queueMicrotask(() => void writeScript(d));
  }, [draft, writing, writeScript]);

  const issues = useMemo(
    () =>
      draft?.script
        ? validateScript(draft.script.lines, draft.intake.goals, draft.settings.style ?? 'scripting')
        : [],
    [draft],
  );
  const errors = issues.filter((i) => i.severity === 'error');
  const runtime = draft?.script
    ? estimateRuntimeSec(draft.script.lines, draft.settings.minutes)
    : 0;

  async function mutate(lines: Line[]) {
    if (!draft) return;
    const next = { ...draft, script: { ...draft.script!, lines } };
    setDraft(next);
    await saveDraft(next);
  }

  async function generate() {
    if (!draft?.script) return;
    setGenerating(true);
    setError(null);
    setProgress('Starting…');
    try {
      const result = await generateTrack(
        draft.script,
        draft.intake,
        draft.settings,
        (p: GenerateProgress) => {
          setProgress(p.message);
          setFraction(p.fraction);
        },
      );

      const id = newId();
      const meta: TrackMeta = {
        id,
        name: draft.name,
        createdAt: Date.now(),
        intake: draft.intake,
        settings: draft.settings,
        script: draft.script,
        measured: result.measurement,
        mime: result.mime,
        bytes: result.blob.size,
        durationSec: result.measurement.durationSec,
      };
      await saveTrack(meta, result.blob);
      router.push(`/play?t=${id}`);
    } catch (e) {
      setError((e as Error).message);
      setGenerating(false);
    }
  }

  if (!draftId) return <Shell title="No draft">{null}</Shell>;
  if (!draft) {
    return (
      <Shell title={error ? 'Cannot open storage' : 'Loading…'} back={{ href: '/', label: 'Library' }}>
        {error && (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-warm-300">{error}</p>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </div>
        )}
      </Shell>
    );
  }

  if (generating) {
    return (
      <Shell title="Generating">
        <div className="space-y-6">
          <p className="text-sm leading-relaxed text-ink-300">{progress}</p>
          <div className="h-px w-full bg-ink-800">
            <div
              className="h-px bg-ink-500 transition-all duration-500"
              style={{ width: `${Math.round(fraction * 100)}%` }}
            />
          </div>
          <Note>
            Keep this tab open and awake. Everything happens on this device — the words go
            straight from your browser to Google and back, and the hour is assembled here.
            Nothing is stored on any server. An hour takes a few minutes.
          </Note>
          {error && <p className="text-sm text-alert-400">{error}</p>}
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title="The script"
      back={{ href: '/', label: 'Library' }}
      right={
        <div className="text-right">
          <div className="text-sm tabular-nums text-ink-100">{formatDuration(runtime)}</div>
          <div className="text-xs text-ink-500">of {draft.settings.minutes}:00 target</div>
        </div>
      }
    >
      {writing && <p className="text-sm text-ink-300">Writing…</p>}
      {error && <p className="mb-4 text-sm text-alert-400">{error}</p>}

      {draft.script && (
        <>
          <div className="mb-6 space-y-3">
            <p className="text-xs leading-relaxed text-ink-400">
              {draft.script.lines.length} lines. Edit anything, delete anything, lock the ones
              you want kept if you regenerate. The core lines are heard more than once — the
              runtime above already accounts for that.
            </p>
            {errors.length > 0 && (
              <p className="rounded-lg border border-alert-400/30 bg-ink-900 px-3 py-2 text-xs leading-relaxed text-warm-300">
                {errors.length} line{errors.length === 1 ? '' : 's'} break the writing rules and
                will block generation. They are marked below.
              </p>
            )}
          </div>

          {ARC.filter((s) => s.section !== 'fade').map((spec) => {
            const lines = draft.script!.lines.filter((l) => l.section === spec.section);
            if (lines.length === 0) return null;
            return (
              <section key={spec.section} className="mb-10">
                <div className="mb-3 border-b border-ink-800 pb-2">
                  <h2 className="text-sm text-ink-200">{spec.label}</h2>
                  <p className="text-xs text-ink-500">{spec.purpose}</p>
                </div>
                <ul className="space-y-1">
                  {lines.map((line) => (
                    <LineRow
                      key={line.id}
                      line={line}
                      issues={issues.filter((i) => i.lineId === line.id)}
                      goal={draft.intake.goals.find((g) => g.id === line.goalId)}
                      onChange={(text) =>
                        mutate(draft.script!.lines.map((l) => (l.id === line.id ? { ...l, text } : l)))
                      }
                      onDelete={() => mutate(draft.script!.lines.filter((l) => l.id !== line.id))}
                      onToggleLock={() =>
                        mutate(
                          draft.script!.lines.map((l) =>
                            l.id === line.id ? { ...l, locked: !l.locked } : l,
                          ),
                        )
                      }
                      onRegenerate={async () => {
                        const raw = await generateText(
                          buildRepairPrompt(
                            draft.intake,
                            line,
                            ['give a different wording'],
                            draft.settings.style ?? 'scripting',
                          ),
                        );
                        const fixed = acceptRepair(
                          draft.intake,
                          line,
                          raw,
                          draft.settings.style ?? 'scripting',
                        );
                        if (fixed) {
                          await mutate(
                            draft.script!.lines.map((l) =>
                              l.id === line.id ? { ...l, text: fixed.text } : l,
                            ),
                          );
                        }
                      }}
                    />
                  ))}
                </ul>
              </section>
            );
          })}

          <div className="sticky bottom-0 -mx-5 border-t border-ink-800 bg-ink-950/95 px-5 py-4 backdrop-blur">
            <div className="flex items-center justify-between gap-4">
              <Button variant="quiet" onClick={() => writeScript(draft)} disabled={writing}>
                Rewrite from scratch
              </Button>
              <Button variant="primary" onClick={generate} disabled={errors.length > 0}>
                {errors.length > 0 ? `${errors.length} to fix` : 'Generate the audio'}
              </Button>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}

function LineRow({
  line,
  issues,
  goal,
  onChange,
  onDelete,
  onToggleLock,
  onRegenerate,
}: {
  line: Line;
  issues: Array<{ severity: string; rule: string; message: string; match?: string }>;
  goal?: { text: string };
  onChange: (text: string) => void;
  onDelete: () => void;
  onToggleLock: () => void;
  onRegenerate: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(line.text);
  const [busy, setBusy] = useState(false);
  const err = issues.find((i) => i.severity === 'error');

  // The draft value is seeded when editing starts rather than synced from props, so a
  // rewrite landing mid-edit cannot silently overwrite what is being typed.
  const startEditing = () => {
    setValue(line.text);
    setEditing(true);
  };

  return (
    <li
      className={`group rounded-lg border px-3 py-2 ${
        err ? 'border-alert-400/40 bg-ink-900' : 'border-transparent hover:border-ink-800'
      }`}
    >
      {editing ? (
        <textarea
          autoFocus
          value={value}
          rows={2}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (value.trim() && value !== line.text) onChange(value.trim());
          }}
          className="w-full resize-none rounded border border-ink-600 bg-ink-850 px-2 py-1 text-sm text-ink-100 focus:outline-none"
        />
      ) : (
        <p
          onClick={startEditing}
          className={`cursor-text text-sm leading-relaxed ${line.locked ? 'text-ink-100' : 'text-ink-200'}`}
        >
          {line.text}
        </p>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <span>{PATTERN_LABEL[line.pattern]}</span>
        {goal && <span className="truncate">· {goal.text.slice(0, 30)}</span>}
        <button onClick={onToggleLock} className="hover:text-ink-200">
          {line.locked ? 'locked' : 'lock'}
        </button>
        <button
          onClick={async () => {
            setBusy(true);
            await onRegenerate();
            setBusy(false);
          }}
          disabled={busy || line.locked}
          className="hover:text-ink-200 disabled:opacity-40"
        >
          {busy ? 'rewriting…' : 'rewrite'}
        </button>
        <button onClick={onDelete} className="hover:text-alert-400">
          delete
        </button>
      </div>

      {err && (
        <p className="mt-1 text-xs leading-relaxed text-warm-300">
          <span className="text-alert-400">{err.rule}</span>
          {err.match ? ` — “${err.match}”. ` : ' — '}
          {err.message}
        </p>
      )}
    </li>
  );
}

export type { Section };
