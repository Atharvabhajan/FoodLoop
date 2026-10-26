import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

export type RescueStatus =
  | 'RESERVED'
  | 'AWAITING_RUNNER'
  | 'PICKUP_ASSIGNED'
  | 'PICKUP_CONFIRMED'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'RECIPIENT_CONFIRMED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'PICKUP_FAILED'
  | 'DELIVERY_FAILED';

export type RescueRole = 'provider' | 'ngo' | 'admin' | 'runner';
export type TransportMode = 'NGO_PICKUP' | 'RUNNER';

export interface Deadlines {
  providerConfirmBy: string;
  runnerBy: string | null;
  pickupBy: string;
  deliveryConfirmBy: string | null;
}

export interface IncidentItem {
  id: string;
  category: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  blocking: boolean;
  status: 'OPEN' | 'RESOLVED';
  description: string;
  reporterRole: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionCode: string | null;
  resolutionNote: string | null;
  evidenceCount: number;
}

export interface Contact {
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
}

export interface RescueHistoryItem {
  id: string;
  eventType: string;
  fromStatus: RescueStatus | null;
  toStatus: RescueStatus | null;
  actorRole: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RescueView {
  id: string;
  status: RescueStatus;
  version: number;
  viewerRole: RescueRole;
  transportMode: TransportMode;
  blockedByIncident: boolean;
  trackingActive: boolean;
  handedOverAt: string | null;
  runner: { name: string; assignmentStatus: string; phone: string | null } | null;
  incidents: IncidentItem[];
  allowedActions: string[];
  nextAction: { party: RescueRole | null; text: string };
  listing: {
    id: string;
    title: string;
    foodCategory: string;
    servingsOffered: number;
    packaging: string;
    dietaryTags: string[];
    allergenNotes: string | null;
    transportRequired: boolean;
    hasImage: boolean;
    pickupStart: string;
    pickupDeadline: string;
    approximateArea: { city: string; latitude: number | null; longitude: number | null };
    exactPickup: { addressLine: string; city: string; latitude: number | null; longitude: number | null } | null;
  };
  provider: { name: string; contact: Contact | null };
  ngo: {
    name: string;
    city: string | null;
    contact: Contact | null;
    destination: { addressLine: string; city: string | null; latitude: number | null; longitude: number | null } | null;
    approximateArea: { city: string | null; latitude: number | null; longitude: number | null };
  };
  deadlines: Deadlines;
  pickupCode: { issued: boolean; attemptsLeft: number; locked: boolean } | null;
  reservedAt: string;
  providerConfirmedAt: string | null;
  pickedUpAt: string | null;
  collectedServings: number | null;
  deliveredServings: number | null;
  completedAt: string | null;
  closedAt: string | null;
  outcomeCode: string | null;
  outcomeReason: string | null;
  history: RescueHistoryItem[];
}

export interface RescueSummary {
  id: string;
  status: RescueStatus;
  version: number;
  transportMode: TransportMode;
  listingId: string;
  listingTitle: string;
  providerName: string;
  ngoName: string;
  servingsOffered: number;
  collectedServings: number | null;
  deliveredServings: number | null;
  reservedAt: string;
  nextAction: { party: RescueRole | null; text: string };
  deadlines: Deadlines;
}

export const statusLabels: Record<RescueStatus, { label: string; icon: string; cls: string }> = {
  RESERVED: { label: 'Awaiting provider confirmation', icon: '◔', cls: 'border-amber-500 bg-amber-50 text-amber-900' },
  AWAITING_RUNNER: { label: 'Looking for a runner', icon: '◎', cls: 'border-amber-500 bg-amber-50 text-amber-900' },
  PICKUP_ASSIGNED: { label: 'Ready for pickup', icon: '▣', cls: 'border-blue-600 bg-blue-50 text-blue-900' },
  PICKUP_CONFIRMED: { label: 'Collected, awaiting receipt', icon: '▶', cls: 'border-blue-600 bg-blue-50 text-blue-900' },
  IN_TRANSIT: { label: 'On the way to the NGO', icon: '▶', cls: 'border-blue-600 bg-blue-50 text-blue-900' },
  DELIVERED: { label: 'Handed over, awaiting NGO confirmation', icon: '◼', cls: 'border-blue-600 bg-blue-50 text-blue-900' },
  RECIPIENT_CONFIRMED: { label: 'Receipt confirmed', icon: '✓', cls: 'border-stone-900 bg-stone-900 text-white' },
  COMPLETED: { label: 'Completed', icon: '✓', cls: 'border-stone-900 bg-stone-900 text-white' },
  CANCELLED: { label: 'Cancelled', icon: '✕', cls: 'border-red-600 bg-red-50 text-red-900' },
  EXPIRED: { label: 'Expired (not confirmed in time)', icon: '◷', cls: 'border-stone-500 bg-stone-200 text-stone-800' },
  PICKUP_FAILED: { label: 'Pickup failed', icon: '✕', cls: 'border-red-600 bg-red-50 text-red-900' },
  DELIVERY_FAILED: { label: 'Delivery not confirmed', icon: '!', cls: 'border-orange-600 bg-orange-50 text-orange-900' },
};

export const outcomeLabels: Record<string, string> = {
  COMPLETED: 'Completed',
  PROVIDER_REJECTED: 'Declined by the provider',
  PROVIDER_WITHDREW: 'Food withdrawn by the provider',
  NGO_CANCELLED: 'Cancelled by the NGO',
  ADMIN_CANCELLED: 'Cancelled by FoodLoop',
  PROVIDER_NO_RESPONSE: 'Provider did not respond in time',
  PICKUP_NOT_VERIFIED: 'Pickup was not verified in time',
  DELIVERY_NOT_CONFIRMED: 'Delivery was not confirmed in time',
  ADMIN_RESOLVED: 'Resolved by FoodLoop',
  NO_RUNNER_FOUND: 'No runner was found in time',
  TRANSIT_NOT_COMPLETED: 'The delivery was not completed in time',
  ADMIN_MARKED_FAILED: 'Marked as failed by FoodLoop',
};

/** The deadline that currently matters for the rescue's state, with a label. */
export function activeDeadline(r: { status: RescueStatus; deadlines: Deadlines }) {
  if (r.status === 'RESERVED') return { at: r.deadlines.providerConfirmBy, label: 'Provider must confirm' };
  if (r.status === 'AWAITING_RUNNER' && r.deadlines.runnerBy) return { at: r.deadlines.runnerBy, label: 'A runner must be found' };
  if (r.status === 'PICKUP_ASSIGNED') return { at: r.deadlines.pickupBy, label: 'Pickup must be verified' };
  if ((r.status === 'PICKUP_CONFIRMED' || r.status === 'IN_TRANSIT' || r.status === 'DELIVERED') && r.deadlines.deliveryConfirmBy) {
    return { at: r.deadlines.deliveryConfirmBy, label: r.status === 'DELIVERED' ? 'Receipt must be confirmed' : 'Delivery must be completed' };
  }
  return null;
}

/**
 * Refetch trigger: a Socket.IO nudge (authenticated by the session cookie, carries only a rescue id) plus a
 * polling fallback, so the page stays correct if the socket is blocked or drops.
 */
export function useLiveRefresh(onChange: (rescueId?: string) => void, pollMs = 30_000) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const socket = io({ path: '/socket.io', addTrailingSlash: false, withCredentials: true, transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000 });
    socket.on('rescue.updated', (d: { rescueId?: string }) => cb.current(d?.rescueId));
    socket.on('listing.updated', () => cb.current()); // admins only: the unaccepted-supply view changed (id only, ignored)
    socket.on('connect', () => cb.current()); // re-fetch authoritative state after (re)connecting
    const timer = setInterval(() => cb.current(), pollMs);
    return () => {
      clearInterval(timer);
      socket.close();
    };
  }, [pollMs]);
}

export const incidentCategoryLabels: Record<string, string> = {
  FOOD_SAFETY: 'Food safety concern',
  QUANTITY_MISMATCH: 'Quantity does not match',
  PICKUP_PROBLEM: 'Problem at pickup',
  DELIVERY_PROBLEM: 'Problem at delivery',
  RUNNER_UNAVAILABLE: 'Runner unavailable',
  OTHER: 'Something else',
};

export const severityLabels: Record<string, { label: string; icon: string; cls: string }> = {
  LOW: { label: 'Low', icon: '•', cls: 'border-stone-400 bg-stone-100 text-stone-800' },
  MEDIUM: { label: 'Medium', icon: '▲', cls: 'border-amber-500 bg-amber-50 text-amber-900' },
  HIGH: { label: 'High', icon: '!', cls: 'border-orange-600 bg-orange-50 text-orange-900' },
  CRITICAL: { label: 'Critical', icon: '!!', cls: 'border-red-600 bg-red-50 text-red-900' },
};

export const vehicleLabels: Record<string, string> = { FOOT: 'On foot', BICYCLE: 'Bicycle', SCOOTER: 'Scooter / motorbike', CAR: 'Car', VAN: 'Van' };
