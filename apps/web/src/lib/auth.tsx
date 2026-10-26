'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type ApiResult, type Role, type User } from './api';

type Status = 'loading' | 'authenticated' | 'anonymous' | 'unavailable';

interface RegisterInput {
  name: string;
  email: string;
  password: string;
  phone?: string;
  role: Exclude<Role, 'admin'>;
  organizationName?: string;
}

interface AuthState {
  status: Status;
  user: User | null;
  login(email: string, password: string): Promise<ApiResult<{ user: User }>>;
  register(input: RegisterInput): Promise<ApiResult<{ user: User }>>;
  logout(): Promise<void>;
  /** Name and phone only; email, role and status are never self-service. */
  updateAccount(input: { name?: string; phone?: string | null }): Promise<ApiResult<{ user: User }>>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);

  // Restore the session after a refresh: the httpOnly cookie is sent automatically.
  useEffect(() => {
    let cancelled = false;
    api<{ user: User }>('/auth/me').then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setUser(res.data.user);
        setStatus('authenticated');
      } else {
        setUser(null);
        setStatus(res.error.status === 0 || res.error.status >= 500 ? 'unavailable' : 'anonymous');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const adopt = useCallback((res: ApiResult<{ user: User }>) => {
    if (res.ok) {
      setUser(res.data.user);
      setStatus('authenticated');
    }
    return res;
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      login: async (email, password) =>
        adopt(await api<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })),
      register: async (input) =>
        adopt(await api<{ user: User }>('/auth/register', { method: 'POST', body: JSON.stringify(input) })),
      updateAccount: async (input) => adopt(await api<{ user: User }>('/auth/me', { method: 'PATCH', body: JSON.stringify(input) })),
      logout: async () => {
        await api('/auth/logout', { method: 'POST' });
        setUser(null);
        setStatus('anonymous');
      },
    }),
    [status, user, adopt],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
