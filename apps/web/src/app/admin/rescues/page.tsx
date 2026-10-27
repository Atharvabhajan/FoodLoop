'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { RescueList } from '@/components/RescueParts';

export default function AdminRescuesPage() {
  const user = useRoleGuard(['admin']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Rescues" eyebrow="Rescues" subtitle="Every rescue on the platform. Open one to see its history and take admin actions with a recorded reason.">
      <RescueList role="admin" />
    </Shell>
  );
}
