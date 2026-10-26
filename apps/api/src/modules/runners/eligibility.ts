import type { MatchSettings } from '../../config.js';
import { estimateTravel, type Reason } from '../matching/engine.js';

/**
 * Runner eligibility for one rescue (spec 3.2 / FL-006): the runner must be available, have a complete profile
 * with a base position, be within their own operating radius (and the platform's), be able to carry the food, be
 * able to reach the pickup before the listing's deadline, and not already be committed elsewhere.
 * Pure rules; the distance and radius checks come from PostGIS (ST_Distance / ST_DWithin) in the service.
 */
export interface RunnerFacts {
  availability: 'OFFLINE' | 'AVAILABLE' | 'BUSY' | null;
  vehicleType: string | null;
  capacityKg: number | null;
  radiusKm: number | null;
  hasCoordinates: boolean;
  /** Geodesic distance from the runner's base position to the pickup point (metres). */
  distanceM: number | null;
  /** PostGIS ST_DWithin against min(runner radius, platform radius). */
  withinRadius: boolean | null;
  /** The runner already holds another active assignment. */
  busy: boolean;
  /** The runner released or lost this very rescue earlier: not offered it again. */
  previouslyReleased: boolean;
}

export interface JobFacts {
  requiredKg: number;
  pickupStart: Date;
  pickupDeadline: Date;
}

/** Weight to plan for: the listing's own estimate, else servings x a conservative kg-per-serving default. */
export function requiredKg(job: { estimatedKg: number | null; servings: number }, kgPerServing: number): number {
  return job.estimatedKg ?? Math.round(job.servings * kgPerServing * 100) / 100;
}

export interface RunnerEvaluation {
  reasons: Reason[];
  /** Estimated runner -> pickup leg (null without coordinates). */
  travelMinutes: number | null;
  marginMinutes: number | null;
}

export function evaluateRunner(job: JobFacts, runner: RunnerFacts, now: Date, s: MatchSettings): RunnerEvaluation {
  const reasons: Reason[] = [];
  if (runner.availability === null || runner.vehicleType === null || runner.capacityKg === null || runner.radiusKm === null) {
    reasons.push({ code: 'PROFILE_INCOMPLETE', message: 'Complete your vehicle, carrying capacity and operating radius first.' });
  }
  if (runner.availability !== 'AVAILABLE') reasons.push({ code: 'RUNNER_OFFLINE', message: 'Set yourself as available to accept jobs.' });
  if (runner.busy) reasons.push({ code: 'ALREADY_BUSY', message: 'You are already assigned to another rescue.' });
  if (runner.previouslyReleased) reasons.push({ code: 'PREVIOUSLY_RELEASED', message: 'You released this rescue earlier, so it is not offered to you again.' });
  if (runner.capacityKg !== null && runner.capacityKg < job.requiredKg) {
    reasons.push({ code: 'CAPACITY', message: `This load (about ${job.requiredKg} kg) is more than your carrying capacity (${runner.capacityKg} kg).` });
  }

  let travelMinutes: number | null = null;
  let marginMinutes: number | null = null;
  if (!runner.hasCoordinates || runner.distanceM === null) {
    reasons.push({ code: 'NO_COORDINATES', message: 'Add your base location so distances can be calculated.' });
  } else {
    if (runner.withinRadius === false) reasons.push({ code: 'OUTSIDE_RADIUS', message: 'The pickup is outside your operating radius.' });
    // Same estimate model as matching: straight-line x road factor / speed + dispatch buffer. Not a route.
    const t = estimateTravel(runner.distanceM, { pickupStart: job.pickupStart, pickupDeadline: job.pickupDeadline } as never, now, s);
    travelMinutes = t.travelMinutes;
    marginMinutes = t.marginMinutes;
    if (t.marginMinutes < 0) reasons.push({ code: 'TIME_INFEASIBLE', message: 'You could not reach the pickup before its deadline (estimate).' });
  }
  return { reasons, travelMinutes, marginMinutes };
}
