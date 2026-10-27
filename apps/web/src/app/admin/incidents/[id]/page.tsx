'use client';

import { useParams } from 'next/navigation';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { IncidentDetail } from '@/components/AdminIncidents';

export default function AdminIncidentPage() {
  const user = useRoleGuard(['admin']);
  const { id } = useParams<{ id: string }>();
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Incident review" eyebrow="Incidents" back={{ href: '/admin/incidents', label: 'Back to incidents' }} subtitle="Review the report and its evidence, then record how it was resolved. Every decision is kept in the rescue audit history.">
      <IncidentDetail id={id} />
    </Shell>
  );
}
