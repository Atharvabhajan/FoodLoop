export type Role = 'provider' | 'ngo' | 'runner' | 'admin';

export interface Membership {
  organizationId: string;
  organizationName: string;
  organizationType: 'PROVIDER' | 'NGO';
  verificationStatus: string;
  memberRole: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  platformRole: Role;
  permissions: string[];
  memberships: Membership[];
}

export interface ApiError {
  code: string;
  message: string;
  fields: Record<string, string>;
  details: Record<string, unknown>;
  status: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const NETWORK_ERROR: ApiError = {
  code: 'NETWORK_ERROR',
  message: 'Cannot reach the server. Check that the API is running and try again.',
  fields: {},
  details: {},
  status: 0,
};

async function send<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      ...init,
      credentials: 'same-origin',
      // FormData needs the browser to set the multipart boundary itself.
      headers: init.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON response (e.g. the proxy could not reach the API).
  }
  const b = body as { success?: boolean; data?: T; code?: string; message?: string; details?: { fields?: Record<string, string> } & Record<string, unknown> } | null;
  if (res.ok && b?.success) return { ok: true, data: b.data as T };
  return {
    ok: false,
    error: {
      code: b?.code ?? (res.status >= 500 ? 'SERVER_UNAVAILABLE' : 'UNKNOWN'),
      message:
        b?.message ??
        (res.status >= 500 ? 'The server is unavailable. Please try again shortly.' : 'Something went wrong.'),
      fields: b?.details?.fields ?? {},
      details: b?.details ?? {},
      status: res.status,
    },
  };
}

const SESSION_CODES = new Set(['UNAUTHENTICATED', 'TOKEN_EXPIRED']);

/** Calls the API; on an expired access token, renews the session once and retries. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const first = await send<T>(path, init);
  if (first.ok || !SESSION_CODES.has(first.error.code) || path.startsWith('/auth/')) return first;
  const refreshed = await send('/auth/refresh', { method: 'POST' });
  if (!refreshed.ok) return first;
  return send<T>(path, init);
}

export const homePathFor = (role: Role) => `/${role}`;

export type VerificationStatus = 'UNSUBMITTED' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'RESUBMISSION_REQUESTED';

export interface Organization {
  id: string;
  type: 'PROVIDER' | 'NGO';
  name: string;
  verificationStatus: VerificationStatus;
  statusReason: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  addressLine: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  submissionNumber: number;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  myRole: 'owner' | 'manager' | 'operator' | null;
  editable: boolean;
}

export type DocumentType = 'REGISTRATION_CERTIFICATE' | 'FOOD_SAFETY_LICENSE' | 'ID_PROOF' | 'OTHER';

export interface OrgDocument {
  id: string;
  documentType: DocumentType;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  reviewStatus: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  createdAt: string;
}

export interface HistoryItem {
  id: string;
  action: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'RESUBMISSION_REQUESTED';
  toStatus: VerificationStatus;
  reason: string | null;
  submissionNumber: number;
  createdAt: string;
  actorName?: string;
}

export const documentTypeLabels: Record<DocumentType, string> = {
  REGISTRATION_CERTIFICATE: 'Registration certificate (required)',
  FOOD_SAFETY_LICENSE: 'Food safety license',
  ID_PROOF: 'ID proof',
  OTHER: 'Other',
};

export const documentUrl = (orgId: string, docId: string) => `/api/v1/organizations/${orgId}/documents/${docId}/file`;

export const MAX_UPLOAD_MB = 5;
