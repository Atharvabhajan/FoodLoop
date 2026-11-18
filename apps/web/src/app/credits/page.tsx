import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { photoSrc, photos, type PhotoName } from '@/lib/photoCredits';

export const metadata = { title: 'Photo credits · FoodLoop' };

export default function CreditsPage() {
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-10">
      <Link href="/" aria-label="FoodLoop home"><Logo /></Link>
      <h1 className="mt-10 text-4xl font-extrabold text-stone-900">Photo credits</h1>
      <p className="mt-3 max-w-3xl text-stone-600">
        Every photograph in FoodLoop is bundled with the app (nothing is loaded from another site) and comes from Wikimedia Commons under a licence that allows reuse. Each file was resized and compressed for the web.
      </p>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(photos).map(([name, p]) => (
          <li key={name} className="overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-card">
            <img src={photoSrc(name as PhotoName)} alt="" width={p.width} height={p.height} loading="lazy" className="h-40 w-full object-cover" />
            <div className="p-4">
              <p className="font-semibold text-stone-900">{p.title}</p>
              <p className="text-sm text-stone-700">
                By {p.author || 'unknown author'} · {p.license} ·{' '}
                <a href={p.source} className="text-brand-700 underline underline-offset-2" target="_blank" rel="noreferrer">
                  Source page
                </a>
              </p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-sm text-stone-600">The logo and wordmark are original FoodLoop artwork (SVG).</p>
    </main>
  );
}
