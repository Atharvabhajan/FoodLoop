'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { ImpactView } from '@/components/ImpactView';

export default function RunnerImpactPage() {
  const user = useRoleGuard(['runner']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Impact">
      <ImpactView role="runner" />
    </Shell>
  );
}
