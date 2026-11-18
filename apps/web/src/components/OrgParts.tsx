'use client';

import { documentTypeLabels, documentUrl, type HistoryItem, type OrgDocument } from '@/lib/api';

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '-';

const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const actionText: Record<HistoryItem['action'], string> = {
  SUBMITTED: 'Submitted for review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RESUBMISSION_REQUESTED: 'Resubmission requested',
};

const reviewText = { PENDING: 'Awaiting review', ACCEPTED: 'Accepted', REJECTED: 'Rejected' } as const;

export function HistoryList({ history }: { history: HistoryItem[] }) {
  if (history.length === 0) return <p className="mt-2 text-sm text-stone-600">No review activity yet.</p>;
  return (
    <ol className="mt-3 space-y-3">
      {history.map((h) => (
        <li key={h.id} className="border-l-2 border-stone-300 pl-3 text-sm">
          <p className="font-medium">
            {actionText[h.action]} <span className="font-normal text-stone-600">(submission {h.submissionNumber})</span>
          </p>
          <p className="text-stone-600">
            {formatDate(h.createdAt)}
            {h.actorName ? ` · ${h.actorName}` : ''}
          </p>
          {h.reason && <p className="mt-1 text-stone-800">&ldquo;{h.reason}&rdquo;</p>}
        </li>
      ))}
    </ol>
  );
}

export function DocumentList({
  orgId,
  documents,
  onDelete,
  busyId,
}: {
  orgId: string;
  documents: OrgDocument[];
  onDelete?: (doc: OrgDocument) => void;
  busyId?: string | null;
}) {
  if (documents.length === 0) return <p className="mt-2 text-sm text-stone-600">No documents uploaded yet.</p>;
  return (
    <ul className="mt-3 divide-y divide-stone-200 rounded-md border border-stone-200">
      {documents.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium">{d.originalFilename}</p>
            <p className="text-stone-600">
              {documentTypeLabels[d.documentType].replace(' (required)', '')} · {formatSize(d.sizeBytes)} · {reviewText[d.reviewStatus]}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <a href={documentUrl(orgId, d.id)} className="font-medium text-brand-700 underline" download>
              Download
            </a>
            {onDelete && (
              <button
                type="button"
                onClick={() => onDelete(d)}
                disabled={busyId === d.id}
                className="font-medium text-red-700 underline disabled:opacity-50"
                aria-label={`Remove ${d.originalFilename}`}
              >
                Remove
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
