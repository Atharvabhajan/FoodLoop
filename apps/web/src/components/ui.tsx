'use client';

import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { photos, photoSrc, type PhotoName } from '@/lib/photoCredits';

export function Field({
  label,
  error,
  hint,
  id,
  ...props
}: { label: string; error?: string; hint?: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-stone-800">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2.5 text-base shadow-sm placeholder:text-stone-500 ${
          error ? 'border-red-600 bg-red-50/40' : 'border-stone-300 hover:border-stone-400'
        }`}
        {...props}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-sm font-medium text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-sm text-stone-600">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  return (
    <div role="alert" aria-live="polite">
      {message ? (
        <p className="fl-appear flex gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span aria-hidden className="font-bold">!</span>
          <span>{message}</span>
        </p>
      ) : null}
    </div>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full rounded-lg bg-paprika-600 px-4 py-3 font-semibold text-white shadow-sm hover:bg-paprika-700 active:bg-stone-900 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? 'Please wait…' : children}
    </button>
  );
}

type Tone = 'primary' | 'secondary' | 'danger' | 'ghost';
const tones: Record<Tone, string> = {
  primary: 'bg-paprika-600 text-white hover:bg-paprika-700 active:bg-stone-900 shadow-sm',
  secondary: 'border border-stone-300 bg-white text-stone-900 hover:bg-stone-100',
  danger: 'bg-red-700 text-white hover:bg-red-800 shadow-sm',
  ghost: 'text-paprika-700 hover:bg-paprika-50',
};

export function Button({ tone = 'primary', className = '', ...props }: { tone?: Tone } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${tones[tone]} ${className}`}
      {...props}
    />
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="mt-6 space-y-3">
      <span className="sr-only">{label}</span>
      <div className="flex items-center gap-3 text-stone-700" aria-hidden>
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-paprika-600 border-t-transparent" />
        {label}
      </div>
      <div className="skeleton h-24 w-full" aria-hidden />
      <div className="skeleton h-24 w-full" aria-hidden />
    </div>
  );
}

export function Skeleton({ className = 'h-24 w-full' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function EmptyState({ title, children, photo }: { title: string; children?: ReactNode; photo?: PhotoName }) {
  return (
    <div className="fl-appear mt-6 overflow-hidden rounded-2xl border border-dashed border-stone-300 bg-white/70 text-center">
      {photo ? <Photo name={photo} className="h-32 w-full object-cover opacity-90" /> : null}
      <div className="px-6 py-8">
        <p className="font-display text-lg font-semibold text-stone-900">{title}</p>
        {children ? <div className="mx-auto mt-1 max-w-md text-sm text-stone-600">{children}</div> : null}
      </div>
    </div>
  );
}

/** A bundled local photograph with its recorded alt text. Use alt="" via decorative for purely ornamental placements. */
export function Photo({ name, className = '', decorative = false, priority = false }: { name: PhotoName; className?: string; decorative?: boolean; priority?: boolean }) {
  const p = photos[name];
  return (
    <img
      src={photoSrc(name)}
      alt={decorative ? '' : p.alt}
      width={p.width}
      height={p.height}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      className={className}
    />
  );
}

/** Native modal dialog: focus is trapped, Escape closes, focus returns to the opener. */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  tone = 'primary',
  busy = false,
  busyLabel = 'Please wait…',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  tone?: Tone;
  busy?: boolean;
  busyLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="fl-dialog" aria-labelledby={`${id}-title`} onClick={(e) => { if (e.target === ref.current && !busy) onCancel(); }} onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <div className="p-6">
        <h2 id={`${id}-title`} className="text-xl font-bold text-stone-900">{title}</h2>
        {children ? <div className="mt-2 text-sm text-stone-700">{children}</div> : null}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button tone="secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button tone={tone} onClick={onConfirm} disabled={busy}>{busy ? busyLabel : confirmLabel}</Button>
        </div>
      </div>
    </dialog>
  );
}

export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="fl-appear flex gap-2 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm font-medium text-green-900">
      <span aria-hidden>✓</span>
      <span>{children}</span>
    </p>
  );
}

/**
 * Shows a real number. The first value is shown as is; when a later value differs (a rescue completed, a poll came back
 * with new data) it counts from the old value to the new one over ~0.8 s. An unchanged poll does nothing. With
 * reduced motion the new value just appears.
 */
export function CountUp({ value, className = '' }: { value: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (from === value) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 800);
      setShown(Math.round(from + (value - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <span className={`tabular-nums ${className}`}>
      <span aria-hidden>{shown.toLocaleString('en-IN')}</span>
      <span className="sr-only">{value.toLocaleString('en-IN')}</span>
    </span>
  );
}

const avatarTones = ['bg-paprika-600 text-white', 'bg-stone-900 text-saffron-200', 'bg-saffron-300 text-stone-950', 'bg-paprika-800 text-saffron-100', 'bg-stone-700 text-white'];

/** Initials in a warm colour chosen from the name. Not a photo: FoodLoop has no profile-picture upload. */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span aria-hidden className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold ${avatarTones[h % avatarTones.length]}`} style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {initials}
    </span>
  );
}
