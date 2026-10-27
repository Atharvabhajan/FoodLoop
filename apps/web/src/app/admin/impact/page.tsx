'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { ImpactView } from '@/components/ImpactView';

export default function AdminImpactPage() {
  const user = useRoleGuard(['admin']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Impact" eyebrow="Results" subtitle="Platform-wide totals from completed rescues. No organization, person or rescue is identified here.">
      <ImpactView role="admin" />
    </Shell>
  );
}
