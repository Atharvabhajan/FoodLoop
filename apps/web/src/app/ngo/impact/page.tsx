'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { ImpactView } from '@/components/ImpactView';

export default function NgoImpactPage() {
  const user = useRoleGuard(['ngo']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Impact" eyebrow="Results" subtitle="Completed rescues for your organization and the servings you confirmed as received.">
      <ImpactView role="ngo" />
    </Shell>
  );
}
