'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ListingForm } from '@/components/ListingForm';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';

export default function NewListingPage() {
  const user = useRoleGuard(['provider']);
  const router = useRouter();
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="New listing">
      <p className="mt-1 text-sm"><Link href="/provider/listings" className="font-medium text-paprika-700 underline">← Back to listings</Link></p>
      <p className="mt-3 text-sm text-stone-700">Saving creates a draft. You publish it from the next screen once your organization is verified.</p>
      <div className="mt-4">
        <ListingForm submitLabel="Save draft" onSaved={(l) => router.push(`/provider/listings/${l.id}`)} />
      </div>
    </Shell>
  );
}
