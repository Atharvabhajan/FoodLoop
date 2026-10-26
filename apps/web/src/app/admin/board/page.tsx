'use client';

import { Loading, Shell, useRoleGuard } from '@/components/Shell';
import { OpsBoard } from '@/components/OpsBoard';

export default function AdminBoardPage() {
  const user = useRoleGuard(['admin']);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Live operations board">
      <OpsBoard />
    </Shell>
  );
}
