'use client';

import { breakdownLabels, type Breakdown, type EstimateInfo } from '@/lib/supply';

/** Score shown as text ("80 / 100"), never as color alone. */
export function ScoreBadge({ score, rank }: { score: number | null; rank?: number | null }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-paprika-600 bg-paprika-50 px-3 py-0.5 text-sm font-semibold text-stone-900">
      {rank ? <span>#{rank}</span> : null}
      <span>Score {score === null ? '-' : Math.round(score)} / 100</span>
    </span>
  );
}

export function BreakdownTable({ breakdown }: { breakdown: Breakdown }) {
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer font-medium text-paprika-700">How this score is calculated</summary>
      <table className="mt-2 w-full max-w-md border-collapse text-left">
        <caption className="sr-only">Score breakdown</caption>
        <thead>
          <tr className="border-b border-stone-300 text-stone-600">
            <th scope="col" className="py-1 pr-3 font-medium">Factor</th>
            <th scope="col" className="py-1 pr-3 font-medium">Score</th>
            <th scope="col" className="py-1 pr-3 font-medium">Weight</th>
            <th scope="col" className="py-1 font-medium">Points</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(breakdownLabels) as (keyof Breakdown)[]).map((k) => (
            <tr key={k} className="border-b border-stone-100">
              <th scope="row" className="py-1 pr-3 font-normal">{breakdownLabels[k]}</th>
              <td className="py-1 pr-3">{breakdown[k].score.toFixed(0)} / 100</td>
              <td className="py-1 pr-3">{breakdown[k].weight}%</td>
              <td className="py-1">{breakdown[k].points.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function EstimateNote({ estimate }: { estimate: EstimateInfo }) {
  return (
    <p className="mt-2 rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-700">
      <strong>Estimates only.</strong> Distances are straight-line. Travel time assumes about {estimate.roadDistanceFactor}x road distance at {estimate.avgSpeedKmh} km/h plus a {estimate.dispatchBufferMinutes}-minute dispatch buffer. There is no route planning yet, so these are not guaranteed times. Search radius {estimate.searchRadiusKm} km.
    </p>
  );
}

export function DistanceTime({ km, travelMinutes, marginMinutes }: { km: number | null; travelMinutes: number | null; marginMinutes: number | null }) {
  return (
    <p className="mt-1 text-sm text-stone-800">
      {km !== null ? `About ${km.toFixed(1)} km away (straight line, estimate)` : 'Distance unavailable'}
      {travelMinutes !== null ? ` · ~${travelMinutes} min travel (estimate)` : ''}
      {marginMinutes !== null ? ` · ~${Math.max(0, marginMinutes)} min to spare before the deadline (estimate)` : ''}
    </p>
  );
}
