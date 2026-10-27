'use client';

import { useParams } from 'next/navigation';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { RescueDetail } from '@/components/RescueParts';

export default function ProviderRescuePage() {
  const user = useRoleGuard(['provider']);
  const { id } = useParams<{ id: string }>();
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Rescue details" eyebrow="Rescue" back={{ href: '/provider/rescues', label: 'Back to rescues' }}>
      <RescueDetail id={id} role="provider" />
    </Shell>
  );
}
