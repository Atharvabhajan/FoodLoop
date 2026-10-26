'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { RescueList } from '@/components/RescueParts';

export default function NgoRescuesPage() {
  const user = useRoleGuard(['ngo']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Rescues">
      <RescueList role="ngo" />
    </Shell>
  );
}
