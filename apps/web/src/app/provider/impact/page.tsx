'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { ImpactView } from '@/components/ImpactView';

export default function ProviderImpactPage() {
  const user = useRoleGuard(['provider']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Impact" eyebrow="Results" subtitle="What your surplus food has done: completed rescues and the servings recipients confirmed.">
      <ImpactView role="provider" />
    </Shell>
  );
}
