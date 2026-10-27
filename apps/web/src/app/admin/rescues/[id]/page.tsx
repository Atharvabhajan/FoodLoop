'use client';

import { useParams } from 'next/navigation';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { RescueDetail } from '@/components/RescueParts';

export default function AdminRescuePage() {
  const user = useRoleGuard(['admin']);
  const { id } = useParams<{ id: string }>();
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Rescue details" eyebrow="Rescue" back={{ href: '/admin/rescues', label: 'Back to rescues' }}>
      <RescueDetail id={id} role="admin" />
    </Shell>
  );
}
