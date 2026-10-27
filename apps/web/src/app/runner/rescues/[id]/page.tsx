'use client';

import { useParams } from 'next/navigation';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { RescueDetail } from '@/components/RescueParts';

export default function RunnerRescuePage() {
  const user = useRoleGuard(['runner']);
  const { id } = useParams<{ id: string }>();
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Rescue details" eyebrow="Rescue" back={{ href: '/runner/rescues', label: 'Back to my rescues' }}>
      <RescueDetail id={id} role="runner" />
    </Shell>
  );
}
