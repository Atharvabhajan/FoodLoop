'use client';

import type { Role } from '@/lib/api';
import { AdminWorkspace } from './AdminWorkspace';
import { NgoWorkspace } from './NgoWorkspace';
import { ProviderWorkspace } from './ProviderWorkspace';
import { RunnerWorkspace } from './RunnerWorkspace';
import { Loading, Shell, useRoleGuard } from './Shell';

const titles: Record<Role, string> = {
  provider: 'Provider dashboard',
  ngo: 'NGO dashboard',
  runner: 'Runner dashboard',
  admin: 'Operations dashboard',
};

/** Role home: each role gets its own workspace composition. Authorization is enforced by the API. */
export function RolePage({ role }: { role: Role }) {
  const user = useRoleGuard([role]);
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title={titles[role]} wide hideTitle>
      {role === 'ngo' && <NgoWorkspace user={user} />}
      {role === 'provider' && <ProviderWorkspace user={user} />}
      {role === 'runner' && <RunnerWorkspace user={user} />}
      {role === 'admin' && <AdminWorkspace user={user} />}
    </Shell>
  );
}
