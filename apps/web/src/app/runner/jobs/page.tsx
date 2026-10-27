'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { AvailableJobs } from '@/components/RunnerPages';

export default function RunnerJobsPage() {
  const user = useRoleGuard(['runner']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Available jobs" eyebrow="Runner" subtitle="Only jobs you could actually do: within your radius, light enough for your capacity, and reachable before the pickup window closes.">
      <AvailableJobs />
    </Shell>
  );
}
