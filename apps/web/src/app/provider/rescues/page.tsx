'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { RescueList } from '@/components/RescueParts';

export default function ProviderRescuesPage() {
  const user = useRoleGuard(['provider']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Rescues" eyebrow="Rescues" subtitle="Your food on its way to NGOs. Confirm hand-offs and share the pickup code from each rescue.">
      <RescueList role="provider" />
    </Shell>
  );
}
