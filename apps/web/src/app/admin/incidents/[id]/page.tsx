'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { IncidentDetail } from '@/components/AdminIncidents';

export default function AdminIncidentPage() {
  const user = useRoleGuard(['admin']);
  const { id } = useParams<{ id: string }>();
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Incident">
      <p className="mt-1 text-sm"><Link href="/admin/incidents" className="font-medium text-paprika-700 underline">← Back to incidents</Link></p>
      <IncidentDetail id={id} />
    </Shell>
  );
}
