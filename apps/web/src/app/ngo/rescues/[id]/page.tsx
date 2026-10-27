'use client';

import { useParams } from 'next/navigation';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { RescueDetail } from '@/components/RescueParts';

export default function NgoRescuePage() {
  const user = useRoleGuard(['ngo']);
  const { id } = useParams<{ id: string }>();
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Rescue details" eyebrow="Rescue" back={{ href: '/ngo/rescues', label: 'Back to rescues' }}>
      <RescueDetail id={id} role="ngo" />
    </Shell>
  );
}
