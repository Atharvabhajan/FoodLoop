'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { OpsBoard } from '@/components/OpsBoard';

export default function AdminBoardPage() {
  const user = useRoleGuard(['admin']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Live operations board" eyebrow="Operations" subtitle="Active, delayed and finished rescues, live food nobody has accepted yet, and a map of both. Read-only: interventions happen on each rescue page, with a reason.">
      <OpsBoard />
    </Shell>
  );
}
