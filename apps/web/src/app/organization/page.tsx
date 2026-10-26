'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { OrganizationPanel } from '@/components/OrgPanel';

export default function OrganizationPage() {
  const user = useRoleGuard(['provider', 'ngo']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title={user.platformRole === 'provider' ? 'Provider organization' : 'NGO organization'}>
      <OrganizationPanel role={user.platformRole as 'provider' | 'ngo'} />
    </Shell>
  );
}
