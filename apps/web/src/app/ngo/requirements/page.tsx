'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { RequirementsPanel } from '@/components/RequirementsPanel';

export default function RequirementsPage() {
  const user = useRoleGuard(['ngo']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Food needs and capacity">
      <RequirementsPanel />
    </Shell>
  );
}
