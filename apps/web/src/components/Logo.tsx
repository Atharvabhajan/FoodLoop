/** FoodLoop logo mark (a loop of food moving round, with a flame-coloured leaf) and wordmark. Pure SVG, no assets to load. */
export function LogoMark({ size = 36, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className={className}>
      <rect width="64" height="64" rx="16" fill="#bf3f1b" />
      <path d="M32 14a18 18 0 1 0 17.4 22.6" fill="none" stroke="#fff8e3" strokeWidth="6" strokeLinecap="round" />
      <path d="M49.4 36.6 40 38l5-8z" fill="#fff8e3" />
      <path d="M32 22c-5 2.5-7 7-5 12 5-.5 8.5-4 5-12z" fill="#fcc83f" />
    </svg>
  );
}

export function Logo({ size = 36, tone = 'dark' }: { size?: number; tone?: 'dark' | 'light' }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} />
      <span
        className={`font-display text-xl font-bold tracking-tight ${tone === 'light' ? 'text-white' : 'text-stone-900'}`}
        style={{ fontFamily: 'var(--font-display)', fontSize: size * 0.62 }}
      >
        Food<span className={tone === 'light' ? 'text-saffron-200' : 'text-paprika-600'}>Loop</span>
      </span>
    </span>
  );
}
