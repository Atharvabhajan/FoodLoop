import type { PlatformRole } from '../db/schema.js';

/**
 * Phase 1 permission set. Capabilities are granted by platform role; later phases
 * add organization-scoped checks on top of (not instead of) this table.
 */
export const PERMISSIONS = [
  'profile:manage',
  'provider:access',
  'ngo:access',
  'runner:access',
  'admin:access',
  'platform:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const byRole: Record<PlatformRole, readonly Permission[]> = {
  provider: ['profile:manage', 'provider:access'],
  ngo: ['profile:manage', 'ngo:access'],
  runner: ['profile:manage', 'runner:access'],
  admin: ['profile:manage', 'admin:access', 'platform:manage'],
};

export function permissionsFor(role: PlatformRole): readonly Permission[] {
  return byRole[role];
}

export function hasPermission(role: PlatformRole, permission: Permission): boolean {
  return byRole[role].includes(permission);
}
