'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { RunnerProfileForm } from '@/components/RunnerPages';

export default function RunnerProfilePage() {
  const user = useRoleGuard(['runner']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Runner profile">
      <RunnerProfileForm />
    </Shell>
  );
}
