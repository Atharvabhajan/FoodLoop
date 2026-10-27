'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loading } from '@/components/Shell';

/** The runner transport profile now lives on the profile page; this address keeps working. */
export default function Redirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/profile#transport');
  }, [router]);
  return <Loading label="Opening your profile…" />;
}
