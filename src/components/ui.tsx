'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

export function Shell({
  children,
  title,
  back,
  right,
}: {
  children: ReactNode;
  title?: string;
  back?: { href: string; label: string };
  right?: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-5 pb-24 pt-6">
      {(title || back) && (
        <header className="mb-8 flex items-baseline justify-between gap-4">
          <div>
            {back && (
              <Link href={back.href} className="text-sm text-ink-400 hover:text-ink-200">
                ← {back.label}
              </Link>
            )}
            {title && <h1 className="mt-2 text-xl font-normal text-ink-100">{title}</h1>}
          </div>
          {right}
        </header>
      )}
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'quiet' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  const styles = {
    default: 'border-ink-600 bg-ink-800 text-ink-200 hover:bg-ink-700',
    primary: 'border-ink-500 bg-ink-700 text-ink-100 hover:bg-ink-600',
    quiet: 'border-transparent bg-transparent text-ink-400 hover:text-ink-200',
    danger: 'border-ink-700 bg-transparent text-alert-400 hover:bg-ink-850',
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-4 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm text-ink-300">{label}</span>
      {hint && <span className="mt-0.5 block text-xs leading-relaxed text-ink-400">{hint}</span>}
      <div className="mt-2">{children}</div>
    </label>
  );
}

export function TextArea({
  value,
  onChange,
  rows = 3,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-y rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm leading-relaxed text-ink-100 placeholder:text-ink-500 focus:border-ink-500 focus:outline-none"
    />
  );
}

export function Slider({
  value,
  onChange,
  min = 1,
  max = 10,
  step = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full"
    />
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-ink-800 bg-ink-900 px-3 py-2 text-xs leading-relaxed text-ink-400">
      {children}
    </p>
  );
}
