'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { RescueDetail } from '@/components/RescueParts';

export default function RunnerRescuePage() {
  const user = useRoleGuard(['runner']);
  const { id } = useParams<{ id: string }>();
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Rescue">
      <p className="mt-1 text-sm"><Link href="/runner/rescues" className="font-medium text-paprika-700 underline">← Back to my rescues</Link></p>
      <RescueDetail id={id} role="runner" />
    </Shell>
  );
}
