'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { AvailableJobs } from '@/components/RunnerPages';

export default function RunnerJobsPage() {
  const user = useRoleGuard(['runner']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Available jobs">
      <AvailableJobs />
    </Shell>
  );
}
