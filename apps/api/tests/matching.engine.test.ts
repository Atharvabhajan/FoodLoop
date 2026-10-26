import { describe, expect, it } from 'vitest';
import { loadMatchSettings, type MatchSettings } from '../src/config.js';
import {
  GENERIC_REASONS,
  clamp,
  compareRank,
  components,
  estimateTravel,
  evaluate,
  reliabilityScore,
  scoreCandidate,
  type ListingFacts,
  type NgoFacts,
  type RequirementFacts,
} from '../src/modules/matching/engine.js';
import { urgencyFor } from '../src/modules/listings/constants.js';

const settings: MatchSettings = loadMatchSettings({});
const NOW = new Date('2026-10-25T12:00:00Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const listing = (o: Partial<ListingFacts> = {}): ListingFacts => ({
  servings: 45,
  foodCategory: 'COOKED_MEALS',
  dietaryTags: ['VEGETARIAN'],
  pickupStart: at(10),
  pickupDeadline: at(180),
  ...o,
});
const requirement = (o: Partial<RequirementFacts> = {}): RequirementFacts => ({
  foodCategories: ['COOKED_MEALS', 'BAKERY'],
  neededServings: 40,
  capacityServings: 60,
  serviceRadiusKm: 5,
  availableFrom: at(-60),
  availableTo: at(60 * 24),
  intakeEnabled: true,
  dietaryMustHave: [],
  dietaryMustAvoid: [],
  ...o,
});
const ngo = (o: Partial<NgoFacts> = {}): NgoFacts => ({
  hasCoordinates: true,
  distanceM: 2000,
  withinServiceRadius: true,
  requirement: requirement(),
  ...o,
});
const codes = (l: ListingFacts, n: NgoFacts, s = settings) => evaluate(l, n, NOW, s).reasons.map((r) => r.code);

describe('matching settings (validated configuration)', () => {
  it('has documented defaults whose weights follow the specification', () => {
    expect(settings.weights).toEqual({ distance: 35, urgency: 25, quantity: 20, need: 10, reliability: 10 });
    expect(Object.values(settings.weights).reduce((a, b) => a + b, 0)).toBe(100);
    expect(settings).toMatchObject({ searchRadiusKm: 10, roadDistanceFactor: 1.4, avgSpeedKmh: 25, dispatchBufferMinutes: 20, neutralReliability: 50 });
  });

  it('accepts overrides and rejects invalid values', () => {
    const custom = loadMatchSettings({ MATCH_SEARCH_RADIUS_KM: '3', MATCH_WEIGHT_DISTANCE: '50', MATCH_WEIGHT_URGENCY: '10' });
    expect(custom.searchRadiusKm).toBe(3);
    expect(custom.weights.distance).toBe(50);
    expect(() => loadMatchSettings({ MATCH_WEIGHT_DISTANCE: '40' })).toThrow(/add up to 100/);
    expect(() => loadMatchSettings({ MATCH_ROAD_DISTANCE_FACTOR: '0.5' })).toThrow();
    expect(() => loadMatchSettings({ MATCH_AVG_SPEED_KMH: '0' })).toThrow();
    expect(() => loadMatchSettings({ MATCH_SEARCH_RADIUS_KM: 'abc' })).toThrow();
    expect(() => loadMatchSettings({ MATCH_NEUTRAL_RELIABILITY: '150' })).toThrow();
  });
});

describe('travel estimate (clearly an estimate, not a route)', () => {
  it('applies the road factor, average speed and dispatch buffer', () => {
    // 5 km straight line -> 7 km road -> 7 / 25 * 60 = 16.8 -> 17 min; +20 min dispatch = 37 min.
    const t = estimateTravel(5000, listing({ pickupStart: at(0) }), NOW, settings);
    expect(t.straightLineKm).toBe(5);
    expect(t.estimatedRoadKm).toBeCloseTo(7, 10);
    expect(t.travelMinutes).toBe(17);
    expect(t.earliestPickup.getTime()).toBe(at(37).getTime());
    expect(t.marginMinutes).toBe(180 - 37);
  });

  it('never assumes pickup before the pickup window opens', () => {
    const t = estimateTravel(1000, listing({ pickupStart: at(90) }), NOW, settings);
    expect(t.earliestPickup.getTime()).toBe(at(90).getTime());
    expect(t.marginMinutes).toBe(90);
  });

  it('reports negative margin when the trip cannot fit', () => {
    const t = estimateTravel(5000, listing({ pickupStart: at(0), pickupDeadline: at(30) }), NOW, settings);
    expect(t.marginMinutes).toBe(-7);
  });
});

describe('hard eligibility filters', () => {
  it('passes a fully compatible NGO', () => {
    expect(codes(listing(), ngo())).toEqual([]);
  });

  it('requires an active requirement', () => {
    expect(codes(listing(), ngo({ requirement: null }))).toContain('NO_REQUIREMENT');
  });

  it('requires intake to be enabled', () => {
    expect(codes(listing(), ngo({ requirement: requirement({ intakeEnabled: false }) }))).toContain('INTAKE_PAUSED');
  });

  it('requires the availability window to overlap the pickup window', () => {
    expect(codes(listing(), ngo({ requirement: requirement({ availableTo: at(-1) }) }))).toContain('WINDOW_ENDED');
    // Window opens only after the pickup deadline.
    expect(codes(listing(), ngo({ requirement: requirement({ availableFrom: at(181), availableTo: at(600) }) }))).toContain('WINDOW_NO_OVERLAP');
    // Window closes before pickup opens.
    expect(codes(listing(), ngo({ requirement: requirement({ availableFrom: at(-60), availableTo: at(9) }) }))).toContain('WINDOW_NO_OVERLAP');
    // Overlap by one minute is enough; a window that starts mid-pickup-window is fine.
    expect(codes(listing(), ngo({ requirement: requirement({ availableFrom: at(100), availableTo: at(600) }) }))).toEqual([]);
    expect(codes(listing(), ngo({ requirement: requirement({ availableFrom: at(-60), availableTo: at(11) }) }))).toEqual([]);
  });

  it('requires the food category to be accepted', () => {
    expect(codes(listing({ foodCategory: 'DAIRY' }), ngo())).toContain('CATEGORY_NOT_ACCEPTED');
  });

  it('enforces dietary requirements and exclusions', () => {
    expect(codes(listing({ dietaryTags: [] }), ngo({ requirement: requirement({ dietaryMustHave: ['HALAL'] }) }))).toContain('DIETARY_MISSING_REQUIRED');
    expect(codes(listing({ dietaryTags: ['HALAL', 'VEGETARIAN'] }), ngo({ requirement: requirement({ dietaryMustHave: ['HALAL'] }) }))).toEqual([]);
    expect(codes(listing({ dietaryTags: ['CONTAINS_NUTS'] }), ngo({ requirement: requirement({ dietaryMustAvoid: ['CONTAINS_NUTS'] }) }))).toContain('DIETARY_EXCLUDED');
    expect(codes(listing({ dietaryTags: ['VEGAN'] }), ngo({ requirement: requirement({ dietaryMustAvoid: ['CONTAINS_NUTS'] }) }))).toEqual([]);
  });

  it('requires capacity for the FULL quantity (no splitting)', () => {
    expect(codes(listing({ servings: 61 }), ngo())).toContain('INSUFFICIENT_CAPACITY');
    expect(codes(listing({ servings: 60 }), ngo())).toEqual([]);
  });

  it('flags missing coordinates without throwing', () => {
    const result = evaluate(listing(), ngo({ hasCoordinates: false, distanceM: null, withinServiceRadius: null }), NOW, settings);
    expect(result.reasons.map((r) => r.code)).toContain('NGO_NO_COORDINATES');
    expect(result.travel).toBeNull();
  });

  it('enforces the NGO service radius (as decided by PostGIS ST_DWithin)', () => {
    expect(codes(listing(), ngo({ withinServiceRadius: false }))).toContain('OUTSIDE_SERVICE_RADIUS');
    expect(codes(listing(), ngo({ withinServiceRadius: true }))).toEqual([]);
  });

  it('requires the estimated trip to fit before the deadline', () => {
    const tight = listing({ pickupStart: at(0), pickupDeadline: at(30) });
    expect(codes(tight, ngo({ distanceM: 5000 }))).toContain('TIME_INFEASIBLE');
    expect(codes(tight, ngo({ distanceM: 500 }))).toEqual([]);
    // The exact boundary (margin 0) is still feasible.
    const t = estimateTravel(5000, tight, NOW, settings);
    const boundary = listing({ pickupStart: at(0), pickupDeadline: new Date(t.earliestPickup.getTime()) });
    expect(codes(boundary, ngo({ distanceM: 5000 }))).toEqual([]);
  });

  it('reports every failing filter, not just the first', () => {
    const c = codes(listing({ foodCategory: 'DAIRY', servings: 99 }), ngo({ requirement: requirement({ intakeEnabled: false }) }));
    expect(c).toEqual(expect.arrayContaining(['INTAKE_PAUSED', 'CATEGORY_NOT_ACCEPTED', 'INSUFFICIENT_CAPACITY']));
  });

  it('has a generic aggregate wording for every reason code it can emit', () => {
    for (const c of ['NO_REQUIREMENT', 'INTAKE_PAUSED', 'WINDOW_ENDED', 'WINDOW_NO_OVERLAP', 'CATEGORY_NOT_ACCEPTED', 'DIETARY_MISSING_REQUIRED', 'DIETARY_EXCLUDED', 'INSUFFICIENT_CAPACITY', 'NGO_NO_COORDINATES', 'OUTSIDE_SERVICE_RADIUS', 'TIME_INFEASIBLE']) {
      expect(GENERIC_REASONS[c], c).toBeTruthy();
      expect(GENERIC_REASONS[c]).not.toMatch(/\d/); // never leaks an organization's numbers
    }
  });
});

describe('urgency buckets (specification appendix A)', () => {
  it('maps remaining time to NORMAL / PRIORITY / URGENT / CRITICAL / EXPIRED', () => {
    expect(urgencyFor(at(121), NOW)).toBe('NORMAL');
    expect(urgencyFor(at(120), NOW)).toBe('PRIORITY');
    expect(urgencyFor(at(60), NOW)).toBe('PRIORITY');
    expect(urgencyFor(at(59), NOW)).toBe('URGENT');
    expect(urgencyFor(at(30), NOW)).toBe('URGENT');
    expect(urgencyFor(at(29), NOW)).toBe('CRITICAL');
    expect(urgencyFor(at(0), NOW)).toBe('EXPIRED');
    expect(urgencyFor(at(-5), NOW)).toBe('EXPIRED');
  });
});

describe('score components (each normalised to 0-100)', () => {
  it('distance: 100 at the pickup point, 0 at the effective radius, linear between', () => {
    expect(components.distance(0, 5, 10)).toBe(100);
    expect(components.distance(2.5, 5, 10)).toBe(50);
    expect(components.distance(5, 5, 10)).toBe(0);
    // The effective radius is the smaller of the NGO's radius and the platform radius.
    expect(components.distance(5, 20, 10)).toBe(50);
    expect(components.distance(99, 5, 10)).toBe(0); // clamped, never negative
  });

  it('urgency feasibility: proportional to the time margin, capped at the target', () => {
    expect(components.urgency(0, 60)).toBe(0);
    expect(components.urgency(30, 60)).toBe(50);
    expect(components.urgency(60, 60)).toBe(100);
    expect(components.urgency(600, 60)).toBe(100);
  });

  it('quantity fit: 100 when equal, falling with waste or shortfall', () => {
    expect(components.quantity(40, 40)).toBe(100);
    expect(components.quantity(45, 40)).toBeCloseTo(88.888, 2);
    expect(components.quantity(40, 80)).toBe(50);
    expect(components.quantity(80, 40)).toBe(50);
  });

  it('active need: higher when the requirement is already receiving', () => {
    expect(components.need(true)).toBe(100);
    expect(components.need(false)).toBe(60);
  });

  it('reliability is the neutral default with no rescue history', () => {
    expect(reliabilityScore(null, 50)).toBe(50);
    expect(reliabilityScore({ completed: 0, failed: 0 }, 50)).toBe(50);
    expect(reliabilityScore(null, 72)).toBe(72);
  });

  it('reliability with history moves toward the success rate, stays within 0-100, and is smoothed', () => {
    const one = reliabilityScore({ completed: 1, failed: 0 }, 50);
    expect(one).toBeGreaterThan(50);
    expect(one).toBeLessThan(100);
    expect(reliabilityScore({ completed: 100, failed: 0 }, 50)).toBeGreaterThan(95);
    expect(reliabilityScore({ completed: 0, failed: 100 }, 50)).toBeLessThan(5);
    expect(reliabilityScore({ completed: 10, failed: 10 }, 50)).toBe(50);
    expect(clamp(-5)).toBe(0);
    expect(clamp(105)).toBe(100);
  });
});

describe('weighted score', () => {
  const travel = estimateTravel(2000, listing({ pickupStart: at(0) }), NOW, settings);
  const input = { listing: listing({ pickupStart: at(0) }), requirement: requirement(), travel, history: null };

  it('combines the five components with the specification weights', () => {
    const s = scoreCandidate(input, NOW, settings);
    const d = components.distance(2, 5, 10); // 60
    const u = components.urgency(travel.marginMinutes, 60); // capped 100
    const q = components.quantity(45, 40);
    const expected = (d * 35 + u * 25 + q * 20 + 100 * 10 + 50 * 10) / 100;
    expect(s.score).toBeCloseTo(expected, 1);
    expect(s.breakdown.distance).toMatchObject({ score: 60, weight: 35, points: 21 });
    expect(s.breakdown.urgency.weight).toBe(25);
    expect(s.breakdown.quantity.weight).toBe(20);
    expect(s.breakdown.need).toMatchObject({ score: 100, weight: 10, points: 10 });
    expect(s.breakdown.reliability).toMatchObject({ score: 50, weight: 10, points: 5 });
  });

  it('breakdown points add up to the total, and the total is within 0-100', () => {
    const s = scoreCandidate(input, NOW, settings);
    const sum = Object.values(s.breakdown).reduce((a, c) => a + c.points, 0);
    expect(sum).toBeCloseTo(s.score, 1);
    for (const c of Object.values(s.breakdown)) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
    }
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });

  it('is configurable: changing the weights changes the result predictably', () => {
    const distanceOnly = loadMatchSettings({ MATCH_WEIGHT_DISTANCE: '100', MATCH_WEIGHT_URGENCY: '0', MATCH_WEIGHT_QUANTITY: '0', MATCH_WEIGHT_NEED: '0', MATCH_WEIGHT_RELIABILITY: '0' });
    expect(scoreCandidate(input, NOW, distanceOnly).score).toBe(60);
    const reliabilityOnly = loadMatchSettings({ MATCH_WEIGHT_DISTANCE: '0', MATCH_WEIGHT_URGENCY: '0', MATCH_WEIGHT_QUANTITY: '0', MATCH_WEIGHT_NEED: '0', MATCH_WEIGHT_RELIABILITY: '100', MATCH_NEUTRAL_RELIABILITY: '80' });
    expect(scoreCandidate(input, NOW, reliabilityOnly).score).toBe(80);
  });

  it('a closer NGO scores higher, all else equal', () => {
    const near = scoreCandidate({ ...input, travel: estimateTravel(500, input.listing, NOW, settings) }, NOW, settings);
    const far = scoreCandidate({ ...input, travel: estimateTravel(4500, input.listing, NOW, settings) }, NOW, settings);
    expect(near.score).toBeGreaterThan(far.score);
  });
});

describe('deterministic ranking', () => {
  it('orders by score desc, then distance asc, then organization id', () => {
    const items = [
      { organizationId: 'c', score: 80, distanceM: 1000 },
      { organizationId: 'b', score: 90, distanceM: 3000 },
      { organizationId: 'a', score: 80, distanceM: 1000 },
      { organizationId: 'd', score: 80, distanceM: 500 },
    ];
    const order = [...items].sort(compareRank).map((i) => i.organizationId);
    expect(order).toEqual(['b', 'd', 'a', 'c']);
    // Input order does not matter.
    expect([...items].reverse().sort(compareRank).map((i) => i.organizationId)).toEqual(order);
    expect(compareRank(items[0]!, items[0]!)).toBe(0);
  });
});
