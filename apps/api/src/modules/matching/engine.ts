import type { MatchSettings } from '../../config.js';
import type { FoodCategory } from '../../db/schema.js';

/**
 * Pure matching rules: hard eligibility filters, a travel *estimate*, and the weighted score.
 * No database access here, so every rule is unit-testable.
 *
 * Travel time is an ESTIMATE. There is no routing provider, so we take the straight-line geodesic
 * distance (PostGIS), multiply by a road factor, divide by an average speed, and add a fixed dispatch
 * buffer. It is never a real road route or a guaranteed arrival time.
 */

export type ReasonCode =
  | 'NO_REQUIREMENT'
  | 'INTAKE_PAUSED'
  | 'WINDOW_ENDED'
  | 'WINDOW_NO_OVERLAP'
  | 'CATEGORY_NOT_ACCEPTED'
  | 'DIETARY_MISSING_REQUIRED'
  | 'DIETARY_EXCLUDED'
  | 'INSUFFICIENT_CAPACITY'
  | 'NGO_NO_COORDINATES'
  | 'OUTSIDE_SERVICE_RADIUS'
  | 'TIME_INFEASIBLE';

/** Generic, organization-neutral wording used when exclusions are aggregated for other parties. */
export const GENERIC_REASONS: Record<string, string> = {
  NO_REQUIREMENT: 'No food requirements set up',
  INTAKE_PAUSED: 'Intake paused',
  WINDOW_ENDED: 'Availability window ended',
  WINDOW_NO_OVERLAP: 'Availability window does not overlap the pickup window',
  CATEGORY_NOT_ACCEPTED: 'Food category not accepted',
  DIETARY_MISSING_REQUIRED: 'Listing lacks a required dietary tag',
  DIETARY_EXCLUDED: 'Listing has an excluded dietary tag',
  INSUFFICIENT_CAPACITY: 'Capacity below the quantity offered',
  NGO_NO_COORDINATES: 'No valid coordinates, so distance cannot be calculated',
  OUTSIDE_SERVICE_RADIUS: 'Outside the NGO service radius',
  TIME_INFEASIBLE: 'Estimated travel does not fit before the pickup deadline',
  PREVIOUSLY_DECLINED: 'An earlier rescue of this listing by this NGO ended before pickup',
  OUTSIDE_SEARCH_RADIUS: 'Outside the platform search radius',
  NGO_NOT_VERIFIED: 'Organization is not verified',
  LISTING_NO_COORDINATES: 'Listing has no coordinates',
};

export interface Reason {
  code: string;
  message: string;
}

export interface ListingFacts {
  servings: number;
  foodCategory: FoodCategory;
  dietaryTags: string[];
  pickupStart: Date;
  pickupDeadline: Date;
}

export interface RequirementFacts {
  foodCategories: FoodCategory[];
  neededServings: number;
  capacityServings: number;
  serviceRadiusKm: number;
  availableFrom: Date;
  availableTo: Date;
  intakeEnabled: boolean;
  dietaryMustHave: string[];
  dietaryMustAvoid: string[];
}

export interface NgoFacts {
  hasCoordinates: boolean;
  /** Geodesic distance from PostGIS ST_Distance, in metres; null when the NGO has no coordinates. */
  distanceM: number | null;
  /** Result of PostGIS ST_DWithin against the NGO's own service radius. */
  withinServiceRadius: boolean | null;
  requirement: RequirementFacts | null;
}

export interface TravelEstimate {
  straightLineKm: number;
  estimatedRoadKm: number;
  /** Driving time only (road km / average speed). */
  travelMinutes: number;
  /** Earliest plausible pickup: now + travel + dispatch buffer, but never before the window opens. */
  earliestPickup: Date;
  /** Minutes left between the earliest plausible pickup and the deadline (negative means infeasible). */
  marginMinutes: number;
}

const MIN = 60_000;

export function estimateTravel(distanceM: number, listing: ListingFacts, now: Date, s: MatchSettings): TravelEstimate {
  const straightLineKm = distanceM / 1000;
  const estimatedRoadKm = straightLineKm * s.roadDistanceFactor;
  const travelMinutes = Math.ceil((estimatedRoadKm / s.avgSpeedKmh) * 60);
  const ready = now.getTime() + (travelMinutes + s.dispatchBufferMinutes) * MIN;
  const earliest = Math.max(ready, listing.pickupStart.getTime());
  return {
    straightLineKm,
    estimatedRoadKm,
    travelMinutes,
    earliestPickup: new Date(earliest),
    marginMinutes: Math.floor((listing.pickupDeadline.getTime() - earliest) / MIN),
  };
}

const catLabel = (c: string) => c.toLowerCase().replace(/_/g, ' ');

export interface Evaluation {
  /** Empty means the NGO passed every hard filter. */
  reasons: Reason[];
  travel: TravelEstimate | null;
}

/** Applies every hard eligibility filter and reports all that fail (not just the first). */
export function evaluate(listing: ListingFacts, ngo: NgoFacts, now: Date, s: MatchSettings): Evaluation {
  const reasons: Reason[] = [];
  const r = ngo.requirement;

  if (!r) {
    reasons.push({ code: 'NO_REQUIREMENT', message: 'This NGO has not set up its food requirements.' });
  } else {
    if (!r.intakeEnabled) reasons.push({ code: 'INTAKE_PAUSED', message: 'Intake is paused.' });
    if (r.availableTo <= now) {
      reasons.push({ code: 'WINDOW_ENDED', message: 'The availability window has ended.' });
    } else if (!(r.availableFrom < listing.pickupDeadline && r.availableTo > listing.pickupStart)) {
      reasons.push({ code: 'WINDOW_NO_OVERLAP', message: 'The availability window does not overlap the pickup window.' });
    }
    if (!r.foodCategories.includes(listing.foodCategory)) {
      reasons.push({ code: 'CATEGORY_NOT_ACCEPTED', message: `Does not accept ${catLabel(listing.foodCategory)}.` });
    }
    const missing = r.dietaryMustHave.filter((t) => !listing.dietaryTags.includes(t));
    if (missing.length > 0) {
      reasons.push({ code: 'DIETARY_MISSING_REQUIRED', message: `Requires dietary tags the listing lacks: ${missing.map(catLabel).join(', ')}.` });
    }
    const blocked = r.dietaryMustAvoid.filter((t) => listing.dietaryTags.includes(t));
    if (blocked.length > 0) {
      reasons.push({ code: 'DIETARY_EXCLUDED', message: `Cannot accept food tagged: ${blocked.map(catLabel).join(', ')}.` });
    }
    // Whole listing only: partial/split acceptance is out of scope for V1.
    if (r.capacityServings < listing.servings) {
      reasons.push({ code: 'INSUFFICIENT_CAPACITY', message: `Capacity (${r.capacityServings}) is below the ${listing.servings} servings offered.` });
    }
  }

  let travel: TravelEstimate | null = null;
  if (!ngo.hasCoordinates || ngo.distanceM === null) {
    reasons.push({ code: 'NGO_NO_COORDINATES', message: 'The NGO has no valid coordinates, so distance cannot be calculated.' });
  } else {
    if (r && ngo.withinServiceRadius === false) {
      reasons.push({ code: 'OUTSIDE_SERVICE_RADIUS', message: `Outside the NGO's ${r.serviceRadiusKm} km service radius.` });
    }
    travel = estimateTravel(ngo.distanceM, listing, now, s);
    if (travel.marginMinutes < 0) {
      reasons.push({
        code: 'TIME_INFEASIBLE',
        message: `Estimated ${travel.travelMinutes} min travel plus ${s.dispatchBufferMinutes} min dispatch does not fit before the pickup deadline.`,
      });
    }
  }
  return { reasons, travel };
}

/* ------------------------------ scoring ------------------------------ */

export interface RescueHistory {
  completed: number;
  failed: number;
}

/** Pseudo-observations that pull a small sample toward the neutral default. */
const RELIABILITY_PRIOR_WEIGHT = 5;

/**
 * Reliability 0-100. With no completed/failed rescue history (always the case today: there are no
 * rescues yet) this returns the configured neutral default. Once history exists it is the success
 * rate, smoothed toward neutral so one outcome cannot swing it.
 */
export function reliabilityScore(history: RescueHistory | null, neutral: number): number {
  const total = history ? history.completed + history.failed : 0;
  if (!history || total === 0) return neutral;
  const prior = RELIABILITY_PRIOR_WEIGHT;
  const rate = (history.completed + (neutral / 100) * prior) / (total + prior);
  return clamp(rate * 100);
}

export const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface Component {
  /** Normalised 0-100. */
  score: number;
  /** Configured weight (percent). */
  weight: number;
  /** score * weight / 100: this component's contribution to the total. */
  points: number;
}

export interface Breakdown {
  distance: Component;
  urgency: Component;
  quantity: Component;
  need: Component;
  reliability: Component;
}

export interface ScoreInput {
  listing: ListingFacts;
  requirement: RequirementFacts;
  travel: TravelEstimate;
  history: RescueHistory | null;
}

export interface Scored {
  score: number;
  breakdown: Breakdown;
}

/** Component scores (each 0-100). Exported individually so tests can pin every formula. */
export const components = {
  /** 100 at the pickup point, falling linearly to 0 at the effective radius (min of NGO and platform radius). */
  distance(distanceKm: number, serviceRadiusKm: number, platformRadiusKm: number) {
    const radius = Math.min(serviceRadiusKm, platformRadiusKm);
    return clamp(100 * (1 - distanceKm / radius));
  },
  /** Full marks once the estimated time margin reaches the target; proportional below it. */
  urgency(marginMinutes: number, targetMarginMinutes: number) {
    return clamp((100 * marginMinutes) / targetMarginMinutes);
  },
  /** Closeness of the offered servings to the stated need: 100 when equal, smaller the larger the gap (waste or shortfall). */
  quantity(servings: number, neededServings: number) {
    return clamp((100 * Math.min(servings, neededServings)) / Math.max(servings, neededServings));
  },
  /** Every eligible NGO has an explicit requirement; one already receiving scores higher than one whose window starts later. */
  need(windowStarted: boolean) {
    return windowStarted ? 100 : 60;
  },
};

export function scoreCandidate(input: ScoreInput, now: Date, s: MatchSettings): Scored {
  const { listing, requirement: r, travel, history } = input;
  const raw = {
    distance: components.distance(travel.straightLineKm, r.serviceRadiusKm, s.searchRadiusKm),
    urgency: components.urgency(travel.marginMinutes, s.targetMarginMinutes),
    quantity: components.quantity(listing.servings, r.neededServings),
    need: components.need(r.availableFrom <= now),
    reliability: reliabilityScore(history, s.neutralReliability),
  };
  const make = (score: number, weight: number): Component => ({
    score: round2(score),
    weight,
    points: round2((score * weight) / 100),
  });
  const breakdown: Breakdown = {
    distance: make(raw.distance, s.weights.distance),
    urgency: make(raw.urgency, s.weights.urgency),
    quantity: make(raw.quantity, s.weights.quantity),
    need: make(raw.need, s.weights.need),
    reliability: make(raw.reliability, s.weights.reliability),
  };
  const total =
    (raw.distance * s.weights.distance +
      raw.urgency * s.weights.urgency +
      raw.quantity * s.weights.quantity +
      raw.need * s.weights.need +
      raw.reliability * s.weights.reliability) /
    100;
  return { score: round2(clamp(total)), breakdown };
}

/** Human-readable explanation of an eligible match (no private organization data). */
export function explain(input: ScoreInput, s: MatchSettings, now: Date): Reason[] {
  const { listing, requirement: r, travel, history } = input;
  const out: Reason[] = [
    {
      code: 'DISTANCE',
      message: `About ${travel.straightLineKm.toFixed(1)} km away in a straight line (estimated ~${travel.estimatedRoadKm.toFixed(1)} km by road).`,
    },
    { code: 'TIME', message: `Estimated ${travel.travelMinutes} min travel; about ${Math.max(0, travel.marginMinutes)} min to spare before the pickup deadline (estimate).` },
    { code: 'CATEGORY', message: `Accepts ${catLabel(listing.foodCategory)}.` },
    { code: 'CAPACITY', message: `Capacity of ${r.capacityServings} covers all ${listing.servings} servings.` },
    { code: 'QUANTITY', message: `${listing.servings} servings offered vs ${r.neededServings} needed.` },
    { code: 'NEED', message: r.availableFrom <= now ? 'Currently receiving food.' : 'Intake window starts before the pickup deadline.' },
  ];
  const total = history ? history.completed + history.failed : 0;
  out.push({
    code: 'RELIABILITY',
    message: total === 0 ? `No rescue history yet, so a neutral reliability of ${s.neutralReliability} is used.` : `Based on ${total} past rescue${total === 1 ? '' : 's'}.`,
  });
  return out;
}

export interface Rankable {
  organizationId: string;
  score: number;
  distanceM: number;
}

/** Score descending, then distance ascending, then organization id: a stable total order. */
export function compareRank(a: Rankable, b: Rankable): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;
  return a.organizationId < b.organizationId ? -1 : a.organizationId > b.organizationId ? 1 : 0;
}
