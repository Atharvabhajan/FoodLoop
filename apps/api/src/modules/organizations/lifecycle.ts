import type { VerificationStatus } from '../../db/schema.js';

/**
 * Verification lifecycle (names follow the Phase 1 enum):
 *
 *   UNSUBMITTED ──submit──▶ UNDER_REVIEW ──approve──▶ VERIFIED
 *                                │  ├──reject──────▶ REJECTED   (terminal)
 *                                │  └──request resubmission──▶ RESUBMISSION_REQUESTED
 *   RESUBMISSION_REQUESTED ──submit──▶ UNDER_REVIEW
 *
 * REJECTED and VERIFIED are terminal in Phase 2: a rejected applicant starts a new
 * application; revoking verification is a later admin feature.
 */
export type VerificationCommand = 'SUBMIT' | 'APPROVE' | 'REJECT' | 'REQUEST_RESUBMISSION';

const transitions: Record<VerificationCommand, Partial<Record<VerificationStatus, VerificationStatus>>> = {
  SUBMIT: { UNSUBMITTED: 'UNDER_REVIEW', RESUBMISSION_REQUESTED: 'UNDER_REVIEW' },
  APPROVE: { UNDER_REVIEW: 'VERIFIED' },
  REJECT: { UNDER_REVIEW: 'REJECTED' },
  REQUEST_RESUBMISSION: { UNDER_REVIEW: 'RESUBMISSION_REQUESTED' },
};

export function nextStatus(from: VerificationStatus, command: VerificationCommand): VerificationStatus | null {
  return transitions[command][from] ?? null;
}

/** Decisions that must carry an explanation shown to the applicant. */
export const REASON_REQUIRED: readonly VerificationCommand[] = ['REJECT', 'REQUEST_RESUBMISSION'];

/** Profile and documents can be changed only while the applicant owns the next move. */
export function isApplicantEditable(status: VerificationStatus): boolean {
  return status === 'UNSUBMITTED' || status === 'RESUBMISSION_REQUESTED';
}
