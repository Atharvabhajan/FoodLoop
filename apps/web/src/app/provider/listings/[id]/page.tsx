'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ListingForm } from '@/components/ListingForm';
import { BreakdownTable, DistanceTime, EstimateNote, ScoreBadge } from '@/components/MatchParts';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { ListingStatusBadge, TimeLeft, fmtDateTime } from '@/components/SupplyParts';
import { FormError, Photo } from '@/components/ui';
import { MapView } from '@/components/MapView';
import { api } from '@/lib/api';
import { stockPhoto, foodCategoryLabels, listingImageUrl, type Listing, type ListingEvent, type MatchesView } from '@/lib/supply';

const actionText = { PUBLISHED: 'Published', CANCELLED: 'Cancelled', EXPIRED: 'Expired automatically' } as const;
const MAX_IMAGE_MB = 3;

export default function ListingDetailPage() {
  const user = useRoleGuard(['provider']);
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [history, setHistory] = useState<ListingEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [imageVersion, setImageVersion] = useState(0);

  const load = useCallback(async () => {
    const [l, h] = await Promise.all([
      api<{ listing: Listing }>(`/listings/${id}`),
      api<{ history: ListingEvent[] }>(`/listings/${id}/history`),
    ]);
    if (l.ok) setListing(l.data.listing);
    else setError(l.error.status === 404 ? 'This listing was not found.' : l.error.message);
    if (h.ok) setHistory(h.data.history);
  }, [id]);
  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  if (!user) return <Loading label="Restoring your session…" />;

  const changed = async (message: string) => {
    setNotice(message);
    await load();
  };

  return (
    <Shell user={user} title={listing ? listing.title : 'Listing'}>
      <p className="mt-1 text-sm"><Link href="/provider/listings" className="font-medium text-paprika-700 underline">← Back to listings</Link></p>
      {error && <div className="mt-4"><FormError message={error} /></div>}
      {!listing && !error && <Loading label="Loading listing…" />}
      {listing && (
        <div className="mt-4 space-y-6">
          {notice && <p role="status" className="rounded-md border border-green-600 bg-green-50 px-4 py-3 text-sm font-medium text-green-900">✓ {notice}</p>}

          <section aria-labelledby="st-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="st-h" className="text-lg font-semibold">Status</h2>
              <ListingStatusBadge status={listing.status} />
            </div>
            <p className="mt-2 text-sm">
              {listing.status === 'AVAILABLE' && <>Visible to verified NGOs. <TimeLeft deadline={listing.pickupDeadline} urgency={listing.urgency} /> (deadline {fmtDateTime(listing.pickupDeadline)}).</>}
              {listing.status === 'DRAFT' && 'Only your organization can see this draft. Publish it to make it visible to verified NGOs.'}
              {listing.status === 'RESERVED' && 'An NGO has reserved this food. Manage the hand-off on the rescue page.'}
              {listing.status === 'COLLECTED' && 'The food was collected by the NGO.'}
              {listing.status === 'EXPIRED' && `The pickup deadline (${fmtDateTime(listing.pickupDeadline)}) passed. This listing is closed.`}
              {listing.status === 'CANCELLED' && `Cancelled ${fmtDateTime(listing.cancelledAt)}. Reason: ${listing.cancellationReason}`}
            </p>
            <p className="mt-2 text-xs text-stone-600">Publishing makes the listing visible to verified NGOs only. Nearby eligible NGOs are told in waves, and the first to accept reserves it.</p>
          </section>

          <ListingForm key={listing.updatedAt} listing={listing} submitLabel="Save changes" onSaved={() => void changed('Changes saved.')} />

          <ImageSection listing={listing} version={imageVersion} onChanged={async (m) => { setImageVersion((v) => v + 1); await changed(m); }} />

          {(listing.status === 'RESERVED' || listing.status === 'COLLECTED') && <RescueLink listingId={listing.id} />}

          <MatchesSection listing={listing} />

          {listing.status === 'DRAFT' && <PublishSection listing={listing} onPublished={() => changed('Listing published. Verified NGOs can now see it.')} />}
          {(listing.status === 'DRAFT' || listing.status === 'AVAILABLE') && <CancelSection listing={listing} onCancelled={() => changed('Listing cancelled.')} />}

          <section aria-labelledby="hist-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
            <h2 id="hist-h" className="text-lg font-semibold">History</h2>
            {history.length === 0 ? <p className="mt-2 text-sm text-stone-600">No activity yet.</p> : (
              <ol className="mt-3 space-y-3">
                {history.map((h) => (
                  <li key={h.id} className="border-l-2 border-stone-300 pl-3 text-sm">
                    <p className="font-medium">{actionText[h.action]}</p>
                    <p className="text-stone-600">{fmtDateTime(h.createdAt)}</p>
                    {h.reason && <p className="mt-1">&ldquo;{h.reason}&rdquo;</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </Shell>
  );
}


function RescueLink({ listingId }: { listingId: string }) {
  const [rescue, setRescue] = useState<{ id: string; ngoName: string } | null>(null);
  useEffect(() => {
    api<{ rescues: { id: string; ngoName: string }[] }>(`/rescues?scope=all&listingId=${listingId}`).then((r) => r.ok && setRescue(r.data.rescues[0] ?? null));
  }, [listingId]);
  return (
    <section aria-labelledby="resc-h" className="rounded-xl border-2 border-blue-600 bg-white p-5">
      <h2 id="resc-h" className="text-lg font-semibold">Rescue in progress</h2>
      <p className="mt-1 text-sm">An NGO has accepted this listing, so it can no longer be edited or cancelled here.</p>
      {rescue && <Link href={`/provider/rescues/${rescue.id}`} className="mt-3 inline-block inline-flex min-h-11 items-center justify-center rounded-lg bg-paprika-600 px-4 py-2 text-sm font-semibold text-white hover:bg-paprika-700">Open rescue with {rescue.ngoName}</Link>}
    </section>
  );
}

function MatchesSection({ listing }: { listing: Listing }) {
  const [view, setView] = useState<MatchesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = listing.status === 'AVAILABLE';

  const load = useCallback(async () => {
    const res = await api<MatchesView>(`/listings/${listing.id}/matches`);
    if (res.ok) setView(res.data);
    else setError(res.error.code === 'SPATIAL_UNAVAILABLE' ? 'Matching is temporarily unavailable because map support is not ready on the server.' : res.error.message);
  }, [listing.id]);
  useEffect(() => {
    if (live) void load();
  }, [live, load, listing.updatedAt]);

  async function refresh() {
    setBusy(true);
    setError(null);
    const res = await api(`/listings/${listing.id}/matches/refresh`, { method: 'POST' });
    setBusy(false);
    if (res.ok) await load();
    else setError(res.error.code === 'SPATIAL_UNAVAILABLE' ? 'Matching is temporarily unavailable because map support is not ready on the server.' : res.error.message);
  }

  return (
    <section aria-labelledby="match-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="match-h" className="text-lg font-semibold">Matching NGOs (recommendations only)</h2>
        {live && <button onClick={() => void refresh()} disabled={busy} className="rounded-md border border-paprika-600 px-3 py-1.5 text-sm font-semibold text-paprika-700 hover:bg-paprika-50 disabled:opacity-60">{busy ? 'Refreshing…' : 'Refresh matches'}</button>}
      </div>
      <p className="mt-1 text-sm text-stone-600">Eligible verified NGOs are ranked automatically and receive an in-app notification.  The first NGO to accept reserves it, and you then confirm the hand-off.</p>
      <div className="mt-3"><FormError message={error} /></div>

      {!live && <p className="mt-3 text-sm text-stone-700">Matching runs only for available listings. This listing is {listing.status.toLowerCase()}, so it is not matched.</p>}
      {live && !view && !error && <Loading label="Loading matches…" />}
      {live && view && view.listing.unavailableReason === 'LISTING_NO_COORDINATES' && (
        <p role="status" className="mt-3 rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-950">
          This listing has no pickup coordinates, so distances cannot be calculated and no NGOs can be matched. Add latitude and longitude in the details above and save.
        </p>
      )}
      {live && view && view.listing.unavailableReason === 'LISTING_NOT_AVAILABLE' && (
        <p role="status" className="mt-3 text-sm text-stone-700">This listing is no longer open for matching.</p>
      )}
      {live && view && view.listing.matchable && (
        <>
          <EstimateNote estimate={view.estimate} />
          {listing.latitude !== null && listing.longitude !== null && view.candidates.length > 0 && (
            <div>
              <MapView
                title="Where matched NGOs are, by distance from your pickup point"
                height={300}
                markers={[{ id: 'pickup', kind: 'pickup', latitude: listing.latitude, longitude: listing.longitude, label: 'Your pickup point', popup: { title: 'Your pickup point', lines: [listing.addressLine, 'Only you and admins see this exact point.'] } }]}
                circles={view.candidates.filter((c) => c.estimatedDistanceKm !== null).map((c) => ({ latitude: listing.latitude!, longitude: listing.longitude!, radiusKm: c.estimatedDistanceKm!, label: `#${c.rank} ${c.organizationName}: about ${c.estimatedDistanceKm} km (straight line)` }))}
              />
              <p className="mt-1 text-xs text-stone-600">Each ring is one matched NGO at its straight-line distance from your pickup point. NGO locations are not shown to you before a rescue is accepted; hover a ring to see which NGO it is.</p>
            </div>
          )}
          {view.candidates.length === 0 ? (
            <p className="mt-3 rounded-md border border-dashed border-stone-300 p-4 text-sm text-stone-700">No eligible NGOs right now. New NGOs and changed needs are picked up automatically.</p>
          ) : (
            <ol className="mt-3 space-y-3">
              {view.candidates.map((c) => (
                <li key={c.organizationId} className="rounded-lg border border-stone-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">{c.organizationName}{c.city ? ` · ${c.city}` : ''}</span>
                    <ScoreBadge score={c.score} rank={c.rank} />
                  </div>
                  <DistanceTime km={c.estimatedDistanceKm} travelMinutes={c.estimatedTravelMinutes} marginMinutes={c.estimatedMarginMinutes} />
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-stone-800">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                  <BreakdownTable breakdown={c.breakdown} />
                </li>
              ))}
            </ol>
          )}
          {view.excluded.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer font-medium text-stone-700">Why other NGOs were not matched ({view.excluded.reduce((n, e) => n + e.count, 0)})</summary>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-stone-700">
                {view.excluded.map((e) => <li key={e.code}>{e.message}: {e.count}</li>)}
              </ul>
            </details>
          )}
          {view.computedAt && <p className="mt-2 text-xs text-stone-600">Last computed {fmtDateTime(view.computedAt)}</p>}
        </>
      )}
    </section>
  );
}

function PublishSection({ listing, onPublished }: { listing: Listing; onPublished: () => Promise<void> }) {
  const [declaration, setDeclaration] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    api<{ declaration: string }>('/listings/declaration').then((r) => r.ok && setDeclaration(r.data.declaration));
  }, []);

  async function publish(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    const res = await api(`/listings/${listing.id}/publish`, { method: 'POST', body: JSON.stringify({ declarationAccepted: accepted }) });
    setBusy(false);
    if (res.ok) await onPublished();
    else {
      setFields(res.error.fields);
      setError(
        res.error.code === 'ORGANIZATION_NOT_VERIFIED'
          ? 'Your organization must be verified before you can publish. Check your verification status on the Organization page.'
          : res.error.code === 'VALIDATION_ERROR' ? 'Please fix the highlighted problems, then try again.' : res.error.message,
      );
    }
  }

  return (
    <form onSubmit={publish} aria-labelledby="pub-h" className="rounded-xl border-2 border-paprika-600 bg-white p-5">
      <h2 id="pub-h" className="text-lg font-semibold">Publish</h2>
      <p className="mt-1 text-sm text-stone-700">Publishing needs a pickup deadline at least 15 minutes away, and your confirmation below. FoodLoop does not certify food safety.</p>
      <label className="mt-3 flex gap-3 rounded-md border border-stone-300 p-3 text-sm">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-1" />
        <span>{declaration || 'Loading declaration…'}</span>
      </label>
      {fields.declarationAccepted && <p className="mt-1 text-sm text-red-700">{fields.declarationAccepted}</p>}
      {Object.entries(fields).filter(([k]) => k !== 'declarationAccepted').map(([k, v]) => <p key={k} className="mt-1 text-sm text-red-700">{v}</p>)}
      <div className="mt-3"><FormError message={error} /></div>
      <button type="submit" disabled={busy} className="mt-4 rounded-md bg-paprika-600 px-5 py-2.5 font-semibold text-white hover:bg-paprika-700 disabled:opacity-60">
        {busy ? 'Publishing…' : 'Publish listing'}
      </button>
    </form>
  );
}

function CancelSection({ listing, onCancelled }: { listing: Listing; onCancelled: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);

  async function cancel(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setReasonError(null);
    if (reason.trim().length < 3) return setReasonError('A reason is required to cancel.');
    setBusy(true);
    const res = await api(`/listings/${listing.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
    setBusy(false);
    if (res.ok) await onCancelled();
    else {
      setReasonError(res.error.fields.reason ?? null);
      setError(res.error.message);
    }
  }

  if (!open) {
    return (
      <section className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
        <h2 className="text-lg font-semibold">Cancel listing</h2>
        <button onClick={() => setOpen(true)} className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg border border-red-600 px-4 py-2 text-sm font-semibold text-red-800 hover:bg-red-50">Cancel this listing…</button>
      </section>
    );
  }
  return (
    <form onSubmit={cancel} noValidate aria-labelledby="can-h" className="rounded-xl border border-red-300 bg-white p-5">
      <h2 id="can-h" className="text-lg font-semibold">Cancel listing</h2>
      <p className="mt-1 text-sm text-stone-700">Cancelling is final and stays in the listing history.</p>
      <label htmlFor="can-reason" className="mt-3 block text-sm font-medium">Reason (required)</label>
      <textarea id="can-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={reasonError ? true : undefined} className={`mt-1 block w-full rounded-md border px-3 py-2 ${reasonError ? 'border-red-600' : 'border-stone-300'}`} />
      {reasonError && <p className="mt-1 text-sm text-red-700">{reasonError}</p>}
      <div className="mt-3"><FormError message={error} /></div>
      <div className="mt-3 flex gap-3">
        <button type="submit" disabled={busy} className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60">{busy ? 'Cancelling…' : 'Confirm cancellation'}</button>
        <button type="button" onClick={() => setOpen(false)} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium">Keep listing</button>
      </div>
    </form>
  );
}

function ImageSection({ listing, version, onChanged }: { listing: Listing; version: number; onChanged: (message: string) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const editable = listing.editable;

  async function upload(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) return setError('Choose a PNG or JPEG image first.');
    if (file.size > MAX_IMAGE_MB * 1024 * 1024) return setError(`That image is larger than ${MAX_IMAGE_MB} MB.`);
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    const res = await api(`/listings/${listing.id}/image`, { method: 'POST', body: form });
    setBusy(false);
    if (res.ok) {
      setFile(null);
      setInputKey((k) => k + 1);
      await onChanged('Photo saved.');
    } else setError(res.error.fields.file ?? res.error.message);
  }

  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function remove() {
    setBusy(true);
    const res = await api(`/listings/${listing.id}/image`, { method: 'DELETE' });
    setBusy(false);
    if (res.ok) await onChanged('Photo removed.');
    else setError(res.error.message);
  }

  return (
    <section aria-labelledby="img-h" className="rounded-2xl border border-stone-200 bg-white shadow-card p-5">
      <h2 id="img-h" className="text-lg font-semibold">Photo (optional)</h2>
      <p className="mt-1 text-sm text-stone-600">PNG or JPEG, up to {MAX_IMAGE_MB} MB. Location data embedded in the photo is removed on upload.</p>
      {listing.hasImage ? (
        <img src={`${listingImageUrl(listing.id)}?v=${version}`} alt={`Photo of ${listing.title}`} className="mt-3 max-h-64 rounded-md border border-stone-200" />
      ) : (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-dashed border-stone-300 bg-stone-100 p-3">
          <Photo name={stockPhoto(listing.title, listing.foodCategory)} decorative className="h-16 w-24 rounded-lg object-cover" />
          <p className="text-sm text-stone-700">No photo yet. NGOs will see a generic {foodCategoryLabels[listing.foodCategory].toLowerCase()} picture marked as illustrative. A real photo of the food gets accepted faster.</p>
        </div>
      )}
      {preview && (
        <figure className="mt-3">
          <img src={preview} alt="Preview of the photo you chose" className="max-h-64 rounded-xl border border-paprika-300" />
          <figcaption className="mt-1 text-xs text-stone-600">Preview only. It is not saved until you press the upload button.</figcaption>
        </figure>
      )}
      {editable && (
        <form onSubmit={upload} className="mt-3 flex flex-wrap items-end gap-3" noValidate>
          <div>
            <label htmlFor="img-file" className="block text-sm font-medium">Choose image</label>
            <input key={inputKey} id="img-file" type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 text-sm" />
          </div>
          <button type="submit" disabled={busy} className="inline-flex min-h-11 items-center justify-center rounded-lg bg-paprika-600 px-4 py-2 text-sm font-semibold text-white hover:bg-paprika-700 disabled:opacity-60">{busy ? 'Working…' : listing.hasImage ? 'Replace photo' : 'Upload photo'}</button>
          {listing.hasImage && <button type="button" onClick={() => void remove()} disabled={busy} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-red-600 px-4 py-2 text-sm font-medium text-red-800 disabled:opacity-60">Remove photo</button>}
        </form>
      )}
      <div className="mt-3"><FormError message={error} /></div>
    </section>
  );
}
