import type { ListingStatus } from '../../db/schema.js';

/**
 * Listing lifecycle (Phase 3):
 *
 *   DRAFT ──publish──▶ AVAILABLE ──deadline passes──▶ EXPIRED   (terminal)
 *     │                    │
 *     └──────cancel────────┴──────────────────────────▶ CANCELLED (terminal)
 *
 * Phase 5 adds RESERVED (an active rescue holds the listing) and COLLECTED (food left the provider).
 * Those are set only by the rescue service, never by these listing commands.
 */
export type ListingCommand = 'PUBLISH' | 'CANCEL' | 'EXPIRE';

const transitions: Record<ListingCommand, Partial<Record<ListingStatus, ListingStatus>>> = {
  PUBLISH: { DRAFT: 'AVAILABLE' },
  CANCEL: { DRAFT: 'CANCELLED', AVAILABLE: 'CANCELLED' },
  EXPIRE: { AVAILABLE: 'EXPIRED' },
};

export function nextListingStatus(from: ListingStatus, command: ListingCommand): ListingStatus | null {
  return transitions[command][from] ?? null;
}

/**
 * The status a reader should see: an AVAILABLE listing whose deadline has passed is EXPIRED
 * even if the background worker has not recorded that yet, so correctness never depends on the timer.
 */
export function effectiveStatus(listing: { status: ListingStatus; pickupDeadline: Date }, now: Date): ListingStatus {
  return listing.status === 'AVAILABLE' && listing.pickupDeadline.getTime() <= now.getTime() ? 'EXPIRED' : listing.status;
}

/**
 * Single place deciding whether a provider may still change a listing. Later phases add
 * "not reserved by a rescue" here; no rescue concept exists yet.
 */
export function isListingEditable(status: ListingStatus): boolean {
  return status === 'DRAFT' || status === 'AVAILABLE';
}
