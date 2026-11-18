'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { api } from '@/lib/api';
import type { PublicListing } from '@/lib/supply';
import { ConfirmDialog, FormError } from './ui';

/** Accept a live listing. A confirmation dialog states the commitment and (when transport is needed) the transport choice. */
export function AcceptButton({ listing, onStale, label = 'Accept this food', ariaLabel, stretch = false }: { listing: PublicListing; onStale: () => void; label?: string; ariaLabel?: string; stretch?: boolean }) {
  const router = useRouter();
  const gid = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [mode, setMode] = useState<'RUNNER' | 'NGO_PICKUP'>(listing.transportRequired ? 'RUNNER' : 'NGO_PICKUP');

  async function accept() {
    setBusy(true);
    setError(null);
    setReasons([]);
    const res = await api<{ rescue: { id: string } }>(`/listings/${listing.id}/accept`, { method: 'POST', body: JSON.stringify({ transportMode: mode }) });
    setBusy(false);
    if (res.ok) return router.push(`/ngo/rescues/${res.data.rescue.id}`);
    setError(res.error.message);
    if (res.error.code === 'NOT_ELIGIBLE') setReasons(((res.error.details.reasons as { message: string }[]) ?? []).map((r) => r.message));
    if (['LISTING_ALREADY_RESERVED', 'LISTING_NOT_AVAILABLE', 'NOT_ELIGIBLE'].includes(res.error.code)) onStale();
    setConfirming(false);
  }

  return (
    <div className={stretch ? 'mt-3 w-full' : 'mt-3'}>
      <button onClick={() => setConfirming(true)} aria-label={ariaLabel} className={`inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 ${stretch ? 'w-full' : ''}`}>{label}</button>
      <ConfirmDialog open={confirming} title={`Accept ${listing.title}?`} confirmLabel="Yes, accept" busy={busy} busyLabel="Accepting…" cancelLabel="Not now" onConfirm={() => void accept()} onCancel={() => setConfirming(false)}>
        <p>
          You are committing to collect <strong>{listing.servings} servings</strong> from {listing.providerName}. The provider must confirm the hand-off; the exact address and contacts are shared after that.
        </p>
        {listing.transportRequired && (
          <fieldset className="mt-3">
            <legend className="font-semibold">How will the food reach you?</legend>
            <label className="mt-1 flex items-start gap-2"><input type="radio" name={`mode-${gid}`} checked={mode === 'RUNNER'} onChange={() => setMode('RUNNER')} className="mt-1 accent-brand-600" /><span>Ask a volunteer runner to collect and deliver it (recommended: the provider asked for transport). You can still collect it yourself while no runner has taken the job.</span></label>
            <label className="mt-1 flex items-start gap-2"><input type="radio" name={`mode-${gid}`} checked={mode === 'NGO_PICKUP'} onChange={() => setMode('NGO_PICKUP')} className="mt-1 accent-brand-600" /><span>I will collect it myself.</span></label>
          </fieldset>
        )}
      </ConfirmDialog>
      {error && <div className="mt-2"><FormError message={error} /></div>}
      {reasons.length > 0 && <ul className="mt-1 list-disc pl-5 text-sm text-red-800">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
    </div>
  );
}

