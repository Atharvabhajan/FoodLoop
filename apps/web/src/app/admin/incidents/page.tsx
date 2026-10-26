'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { IncidentQueue } from '@/components/AdminIncidents';

export default function AdminIncidentsPage() {
  const user = useRoleGuard(['admin']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Incidents">
      <IncidentQueue />
    </Shell>
  );
}
