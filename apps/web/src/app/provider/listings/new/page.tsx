'use client';

import { useRouter } from 'next/navigation';
import { ListingForm } from '@/components/ListingForm';
import { Loading, Shell, useRoleGuard } from '@/components/Shell';

export default function NewListingPage() {
  const user = useRoleGuard(['provider']);
  const router = useRouter();
  if (!user) return <Loading label="Restoring your session…" />;
  return (
    <Shell user={user} title="Post surplus food" eyebrow="New listing" back={{ href: '/provider/listings', label: 'Back to listings' }} subtitle="Saving creates a draft. You publish it from the next screen once your organization is verified; nearby NGOs then see the food and its approximate area.">
      <div>
        <ListingForm submitLabel="Save draft" onSaved={(l) => router.push(`/provider/listings/${l.id}`)} />
      </div>
    </Shell>
  );
}
