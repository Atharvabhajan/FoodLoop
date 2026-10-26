'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { ImpactView } from '@/components/ImpactView';

export default function NgoImpactPage() {
  const user = useRoleGuard(['ngo']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Impact">
      <ImpactView role="ngo" />
    </Shell>
  );
}
