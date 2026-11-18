import type { RescueStatus } from '@/lib/rescue';

const steps = ['Reserved', 'Hand-off confirmed', 'Collected', 'On the way', 'Handed over', 'Completed'];
const position: Partial<Record<RescueStatus, number>> = {
  RESERVED: 0,
  AWAITING_RUNNER: 1,
  PICKUP_ASSIGNED: 1,
  PICKUP_CONFIRMED: 2,
  IN_TRANSIT: 3,
  DELIVERED: 4,
  RECIPIENT_CONFIRMED: 5,
  COMPLETED: 5,
};

/**
 * Where a rescue is on its way, drawn from its real status. Steps that were reached are filled and ticked, the current one
 * is ringed and announced with aria-current. A rescue that ended some other way (cancelled, expired, failed) shows no
 * progress, because the status badge already says how it ended.
 */
export function StageTrack({ status, compact = false }: { status: RescueStatus; compact?: boolean }) {
  const at = position[status];
  if (at === undefined) return null;
  return (
    <ol aria-label="Rescue progress" className="mt-3 flex items-start gap-1">
      {steps.map((label, i) => {
        const done = i < at || (status === 'COMPLETED' && i === at) || (status === 'RECIPIENT_CONFIRMED' && i === at);
        const current = i === at && !done;
        return (
          <li key={label} aria-current={current ? 'step' : undefined} className="min-w-0 flex-1 text-center">
            <div className="flex items-center">
              <span className={`h-1 flex-1 rounded ${i === 0 ? 'opacity-0' : done || current ? 'bg-brand-500' : 'bg-stone-200'}`} aria-hidden />
              <span
                aria-hidden
                className={`mx-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[10px] font-bold ${
                  done ? 'border-brand-600 bg-brand-600 text-white' : current ? 'border-brand-600 bg-white text-brand-700 ring-4 ring-brand-100' : 'border-stone-300 bg-white text-stone-400'
                }`}
              >
                {done ? '✓' : i + 1}
              </span>
              <span className={`h-1 flex-1 rounded ${i === steps.length - 1 ? 'opacity-0' : done ? 'bg-brand-500' : 'bg-stone-200'}`} aria-hidden />
            </div>
            <span className={`mt-1 block text-[11px] leading-tight ${compact ? 'sr-only' : 'hidden sm:block'} ${current ? 'font-bold text-stone-900' : done ? 'text-stone-700' : 'text-stone-500'}`}>{label}</span>
            <span className="sr-only">{`${label}: ${done ? 'done' : current ? 'current step' : 'not yet'}`}</span>
          </li>
        );
      })}
    </ol>
  );
}
