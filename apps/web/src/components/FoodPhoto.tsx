'use client';

import { listingImageUrl, stockPhoto, type PublicListing } from '@/lib/supply';
import { Photo } from './ui';

/** Uploaded photo when the provider added one, otherwise an honestly labelled illustrative stock photo. */
export function FoodPhoto({ l, className, label = true }: { l: Pick<PublicListing, 'id' | 'title' | 'foodCategory' | 'hasImage'>; className: string; label?: boolean }) {
  return (
    <div className="relative h-full overflow-hidden">
      {l.hasImage ? (
        <img src={listingImageUrl(l.id)} alt={`Photo of ${l.title}`} className={className} />
      ) : (
        <>
          <Photo name={stockPhoto(l.title, l.foodCategory)} decorative className={className} />
          {label && <span className="absolute bottom-1 left-1 rounded bg-stone-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">Illustrative photo</span>}
        </>
      )}
    </div>
  );
}

