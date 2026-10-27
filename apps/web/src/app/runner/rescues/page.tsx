'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { RescueList } from '@/components/RescueParts';

export default function RunnerRescuesPage() {
  const user = useRoleGuard(['runner']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="My rescues" eyebrow="Rescues" subtitle="Deliveries you have taken. The next step is always at the top of each rescue.">
      <RescueList role="runner" />
    </Shell>
  );
}
