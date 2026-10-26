import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { sameLogin } from './db/admin-url.js';

// Default: <repo>/storage/uploads (outside any web root, git-ignored). Same depth from src/ and dist/.
export const DEFAULT_STORAGE_DIR = fileURLToPath(new URL('../../../storage/uploads', import.meta.url));

const num = (def: number, min: number, max: number) => z.coerce.number().min(min).max(max).default(def);

/**
 * Matching settings (all validated). Travel time is an ESTIMATE: straight-line geodesic distance
 * multiplied by a road factor, divided by an average speed, plus a fixed dispatch buffer. There is no
 * routing provider yet, so none of these are real road routes.
 */
const matchSchema = z
  .object({
    /** Platform-wide maximum search radius from a listing; an NGO's own service radius can only narrow it. */
    MATCH_SEARCH_RADIUS_KM: num(10, 0.1, 100),
    /** Straight-line to road-distance multiplier (urban roads are typically 1.2 to 1.5x). */
    MATCH_ROAD_DISTANCE_FACTOR: num(1.4, 1, 3),
    MATCH_AVG_SPEED_KMH: num(25, 5, 80),
    /** Time to dispatch/prepare plus handling at pickup, added to the travel estimate. */
    MATCH_DISPATCH_BUFFER_MINUTES: num(20, 0, 240),
    /** Time margin before the deadline that earns the full urgency-feasibility score. */
    MATCH_TARGET_MARGIN_MINUTES: num(60, 1, 1440),
    MATCH_WEIGHT_DISTANCE: num(35, 0, 100),
    MATCH_WEIGHT_URGENCY: num(25, 0, 100),
    MATCH_WEIGHT_QUANTITY: num(20, 0, 100),
    MATCH_WEIGHT_NEED: num(10, 0, 100),
    MATCH_WEIGHT_RELIABILITY: num(10, 0, 100),
    /** Reliability score for NGOs with no completed-rescue history (no rescue data exists yet). */
    MATCH_NEUTRAL_RELIABILITY: num(50, 0, 100),
  })
  .refine(
    (v) =>
      Math.abs(v.MATCH_WEIGHT_DISTANCE + v.MATCH_WEIGHT_URGENCY + v.MATCH_WEIGHT_QUANTITY + v.MATCH_WEIGHT_NEED + v.MATCH_WEIGHT_RELIABILITY - 100) < 1e-9,
    { message: 'MATCH_WEIGHT_* values must add up to 100' },
  );

export interface MatchSettings {
  searchRadiusKm: number;
  roadDistanceFactor: number;
  avgSpeedKmh: number;
  dispatchBufferMinutes: number;
  targetMarginMinutes: number;
  weights: { distance: number; urgency: number; quantity: number; need: number; reliability: number };
  neutralReliability: number;
}

export function loadMatchSettings(env: NodeJS.ProcessEnv = process.env): MatchSettings {
  const parsed = matchSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'matching'}: ${i.message}`).join('; ');
    throw new Error(`Invalid matching configuration: ${issues}`);
  }
  const v = parsed.data;
  return {
    searchRadiusKm: v.MATCH_SEARCH_RADIUS_KM,
    roadDistanceFactor: v.MATCH_ROAD_DISTANCE_FACTOR,
    avgSpeedKmh: v.MATCH_AVG_SPEED_KMH,
    dispatchBufferMinutes: v.MATCH_DISPATCH_BUFFER_MINUTES,
    targetMarginMinutes: v.MATCH_TARGET_MARGIN_MINUTES,
    weights: {
      distance: v.MATCH_WEIGHT_DISTANCE,
      urgency: v.MATCH_WEIGHT_URGENCY,
      quantity: v.MATCH_WEIGHT_QUANTITY,
      need: v.MATCH_WEIGHT_NEED,
      reliability: v.MATCH_WEIGHT_RELIABILITY,
    },
    neutralReliability: v.MATCH_NEUTRAL_RELIABILITY,
  };
}

/**
 * Rescue deadlines (Phase 5). All validated; expiry is enforced at read/transition time and by an
 * idempotent worker, so a delayed timer or an API restart never leaves a stale state actionable.
 */
const rescueSchema = z.object({
  /** How long a Provider has to confirm (or reject) an NGO's acceptance. */
  RESCUE_PROVIDER_CONFIRM_MINUTES: num(15, 1, 240),
  /** How early before the pickup window opens the NGO may verify pickup. */
  RESCUE_PICKUP_EARLY_MINUTES: num(30, 0, 240),
  /** Grace after the listing's pickup deadline before an unverified pickup counts as failed. */
  RESCUE_PICKUP_GRACE_MINUTES: num(30, 0, 240),
  /** How long after pickup the NGO has to confirm what it received before admin follow-up is needed. */
  RESCUE_DELIVERY_CONFIRM_HOURS: num(12, 1, 168),
  /** Wrong pickup-code attempts allowed before the Provider must issue a new code. */
  RESCUE_MAX_CODE_ATTEMPTS: num(5, 1, 20),
  /** Phase 6: how long a rescue waits for a runner to accept before it expires. */
  RESCUE_RUNNER_SEARCH_MINUTES: num(30, 1, 240),
  /** Phase 6: how long an assigned runner has to hand the food over after collecting it. */
  RESCUE_TRANSIT_MINUTES: num(120, 5, 1440),
  /** Phase 6: carrying-capacity estimate when a listing gives no weight (kg per serving). */
  RUNNER_KG_PER_SERVING: num(0.4, 0.05, 5),
  /** Phase 6: minimum seconds between accepted location updates from one runner. */
  RUNNER_LOCATION_MIN_INTERVAL_SECONDS: num(5, 1, 600),
  /** Phase 6: a shared location older than this is treated as unavailable. */
  RUNNER_LOCATION_MAX_AGE_MINUTES: num(10, 1, 120),
  /**
   * Admin board: a rescue stage counts as DELAYED once this share of its allotted time (stage start to the existing stage
   * deadline) has elapsed. Inclusive. Deadlines themselves are unchanged: past them a rescue is already closed as failed.
   */
  OPS_DELAYED_ELAPSED_PERCENT: num(75, 1, 99),
});

export interface RescueSettings {
  providerConfirmMinutes: number;
  pickupEarlyMinutes: number;
  pickupGraceMinutes: number;
  deliveryConfirmHours: number;
  maxCodeAttempts: number;
  runnerSearchMinutes: number;
  transitMinutes: number;
  kgPerServing: number;
  locationMinIntervalSeconds: number;
  locationMaxAgeMinutes: number;
  delayedElapsedPercent: number;
}

export function loadRescueSettings(env: NodeJS.ProcessEnv = process.env): RescueSettings {
  const parsed = rescueSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid rescue configuration: ${issues}`);
  }
  const v = parsed.data;
  return {
    providerConfirmMinutes: v.RESCUE_PROVIDER_CONFIRM_MINUTES,
    pickupEarlyMinutes: v.RESCUE_PICKUP_EARLY_MINUTES,
    pickupGraceMinutes: v.RESCUE_PICKUP_GRACE_MINUTES,
    deliveryConfirmHours: v.RESCUE_DELIVERY_CONFIRM_HOURS,
    maxCodeAttempts: Math.round(v.RESCUE_MAX_CODE_ATTEMPTS),
    runnerSearchMinutes: v.RESCUE_RUNNER_SEARCH_MINUTES,
    transitMinutes: v.RESCUE_TRANSIT_MINUTES,
    kgPerServing: v.RUNNER_KG_PER_SERVING,
    locationMinIntervalSeconds: v.RUNNER_LOCATION_MIN_INTERVAL_SECONDS,
    locationMaxAgeMinutes: v.RUNNER_LOCATION_MAX_AGE_MINUTES,
    delayedElapsedPercent: v.OPS_DELAYED_ELAPSED_PERCENT,
  };
}

/**
 * Escalation waves (spec 3.3 Workflow C, 8.4, Appendix B). Every timing, radius and size is configuration.
 * The defaults are the specification's own example policy (T+3 / 15 / 25 / 35 / 45 minutes, 3 / 6 / 10 km), which the spec
 * labels a "proposed demo policy" and says must not be hard-coded; the demo profile in .env.example uses seconds-scale
 * intervals. Fractions of a minute are allowed.
 */
const escalationSchema = z.object({
  /** false = no schedule; matching then notifies every eligible NGO at publish, as before waves existed. */
  ESCALATION_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  ESCALATION_WAVE1_MINUTES: num(3, 0, 1440),
  ESCALATION_WAVE1_RADIUS_KM: num(3, 0.1, 100),
  ESCALATION_WAVE2_MINUTES: num(15, 0, 1440),
  ESCALATION_WAVE2_RADIUS_KM: num(6, 0.1, 100),
  ESCALATION_RUNNER_MINUTES: num(25, 0, 1440),
  ESCALATION_RUNNER_RADIUS_KM: num(6, 0.1, 100),
  ESCALATION_WAVE3_MINUTES: num(35, 0, 1440),
  ESCALATION_WAVE3_RADIUS_KM: num(10, 0.1, 100),
  ESCALATION_ADMIN_MINUTES: num(45, 0, 1440),
  /** Most NGO organizations told per wave (best match score first). */
  ESCALATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  /** Most runners told in the runner wave (nearest first). */
  ESCALATION_RUNNER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  /** Timings are multiplied by this for URGENT listings (under 60 min left) and CRITICAL ones (under 30): "faster escalation". */
  ESCALATION_URGENT_SCALE: num(0.5, 0, 1),
  ESCALATION_CRITICAL_SCALE: num(0, 0, 1),
  /** No step is scheduled later than this long before the pickup deadline (so the admin alert can still be useful). */
  ESCALATION_DEADLINE_MARGIN_MINUTES: num(5, 0, 120),
  /** How often the worker looks for due steps; 0 disables the worker (publish still runs steps that are already due). */
  ESCALATION_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
});

export interface EscalationSettings {
  enabled: boolean;
  /** In order. NGO waves and the runner wave carry a radius; the admin alert does not. */
  steps: { seq: number; kind: 'NGO_WAVE' | 'RUNNER_WAVE' | 'ADMIN_ALERT'; offsetMinutes: number; radiusKm: number | null }[];
  batchSize: number;
  runnerBatchSize: number;
  urgentScale: number;
  criticalScale: number;
  deadlineMarginMinutes: number;
  intervalSeconds: number;
}

export function loadEscalationSettings(env: NodeJS.ProcessEnv = process.env): EscalationSettings {
  const parsed = escalationSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid escalation configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const v = parsed.data;
  const steps: EscalationSettings['steps'] = [
    { seq: 1, kind: 'NGO_WAVE', offsetMinutes: v.ESCALATION_WAVE1_MINUTES, radiusKm: v.ESCALATION_WAVE1_RADIUS_KM },
    { seq: 2, kind: 'NGO_WAVE', offsetMinutes: v.ESCALATION_WAVE2_MINUTES, radiusKm: v.ESCALATION_WAVE2_RADIUS_KM },
    { seq: 3, kind: 'RUNNER_WAVE', offsetMinutes: v.ESCALATION_RUNNER_MINUTES, radiusKm: v.ESCALATION_RUNNER_RADIUS_KM },
    { seq: 4, kind: 'NGO_WAVE', offsetMinutes: v.ESCALATION_WAVE3_MINUTES, radiusKm: v.ESCALATION_WAVE3_RADIUS_KM },
    { seq: 5, kind: 'ADMIN_ALERT', offsetMinutes: v.ESCALATION_ADMIN_MINUTES, radiusKm: null },
  ];
  // Steps run in this order, so their times must not go backwards, and a later NGO wave must not narrow the search.
  for (let i = 1; i < steps.length; i++) {
    if (steps[i]!.offsetMinutes < steps[i - 1]!.offsetMinutes) {
      throw new Error('Invalid escalation configuration: step times must not decrease (wave 1 <= wave 2 <= runner <= wave 3 <= admin alert)');
    }
  }
  if (!(v.ESCALATION_WAVE1_RADIUS_KM <= v.ESCALATION_WAVE2_RADIUS_KM && v.ESCALATION_WAVE2_RADIUS_KM <= v.ESCALATION_WAVE3_RADIUS_KM)) {
    throw new Error('Invalid escalation configuration: NGO wave radii must not shrink (wave 1 <= wave 2 <= wave 3)');
  }
  return {
    enabled: v.ESCALATION_ENABLED,
    steps,
    batchSize: v.ESCALATION_BATCH_SIZE,
    runnerBatchSize: v.ESCALATION_RUNNER_BATCH_SIZE,
    urgentScale: v.ESCALATION_URGENT_SCALE,
    criticalScale: v.ESCALATION_CRITICAL_SCALE,
    deadlineMarginMinutes: v.ESCALATION_DEADLINE_MARGIN_MINUTES,
    intervalSeconds: v.ESCALATION_INTERVAL_SECONDS,
  };
}

/**
 * Rate limits (Phase 7). Each limiter counts requests per authenticated user (per IP before sign-in) in a fixed window.
 * Counters live in this process's memory, so limits are per API instance (the app is single-node by design).
 */
export const RATE_LIMIT_NAMES = ['AUTH', 'UPLOAD', 'RESCUE_ACTION', 'INCIDENT', 'LOCATION'] as const;
export type RateLimitName = (typeof RATE_LIMIT_NAMES)[number];
export interface RateLimitRule {
  max: number;
  windowSeconds: number;
}
const RATE_LIMIT_DEFAULTS: Record<RateLimitName, RateLimitRule> = {
  AUTH: { max: 60, windowSeconds: 900 },
  UPLOAD: { max: 20, windowSeconds: 600 },
  RESCUE_ACTION: { max: 120, windowSeconds: 300 },
  INCIDENT: { max: 10, windowSeconds: 900 },
  LOCATION: { max: 60, windowSeconds: 60 },
};

function loadRateLimits(env: NodeJS.ProcessEnv): Record<RateLimitName, RateLimitRule> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const n of RATE_LIMIT_NAMES) {
    shape[`RATE_LIMIT_${n}_MAX`] = num(RATE_LIMIT_DEFAULTS[n].max, 1, 100_000);
    shape[`RATE_LIMIT_${n}_WINDOW_SECONDS`] = num(RATE_LIMIT_DEFAULTS[n].windowSeconds, 1, 86_400);
  }
  const parsed = z.object(shape).safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid rate limit configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const v = parsed.data as Record<string, number>;
  return Object.fromEntries(RATE_LIMIT_NAMES.map((n) => [n, { max: Math.round(v[`RATE_LIMIT_${n}_MAX`]!), windowSeconds: Math.round(v[`RATE_LIMIT_${n}_WINDOW_SECONDS`]!) }])) as Record<RateLimitName, RateLimitRule>;
}

/** An unset or blank variable means "not configured" (distinct from 0). */
const optionalInt = (min: number, max: number) =>
  z.preprocess((v) => (v === '' || v === undefined ? undefined : v), z.coerce.number().int().min(min).max(max).optional());

/**
 * Retention policy for the operator command (`npm run retention`). Nothing is ever deleted unless a period is set
 * here AND the command is run with --execute. Minimums stop a typo from wiping recent material.
 */
const retentionSchema = z
  .object({
    /** Days after an incident is resolved before its evidence photos (files and rows) may be removed. */
    RETENTION_EVIDENCE_DAYS: optionalInt(7, 3650),
    /** Days after resolution before the whole resolved incident (report and any remaining photos) may be removed. */
    RETENTION_INCIDENT_DAYS: optionalInt(30, 3650),
    /** Hours an unreferenced file in storage must have existed before it counts as an orphan. */
    RETENTION_ORPHAN_FILE_HOURS: optionalInt(1, 8760),
  })
  .refine((v) => v.RETENTION_EVIDENCE_DAYS === undefined || v.RETENTION_INCIDENT_DAYS === undefined || v.RETENTION_INCIDENT_DAYS >= v.RETENTION_EVIDENCE_DAYS, {
    message: 'RETENTION_INCIDENT_DAYS must not be shorter than RETENTION_EVIDENCE_DAYS',
  });

export interface RetentionPolicy {
  evidenceDays: number | null;
  incidentDays: number | null;
  orphanFileHours: number | null;
}

export function loadRetentionPolicy(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const parsed = retentionSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid retention configuration: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'retention'}: ${i.message}`).join('; ')}`);
  }
  const v = parsed.data;
  return { evidenceDays: v.RETENTION_EVIDENCE_DAYS ?? null, incidentDays: v.RETENTION_INCIDENT_DAYS ?? null, orphanFileHours: v.RETENTION_ORPHAN_FILE_HOURS ?? null };
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string('DATABASE_URL is required').min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string('JWT_ACCESS_SECRET is required').min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://127.0.0.1:3000'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** How often the in-process expiry job runs; 0 disables it (reads still filter by deadline). */
  EXPIRY_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(60),
  STORAGE_DIR: z.string().min(1).default(DEFAULT_STORAGE_DIR),
  RATE_LIMIT_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /**
   * How the API reacts to a database role with excessive privileges. Default: enforce in production, warn elsewhere
   * (the warning is repeated on every start). Production cannot be set to warn.
   */
  DB_PRIVILEGE_CHECK: z.enum(['enforce', 'warn']).optional(),
  /** Reverse-proxy hops in front of the API whose X-Forwarded-For may be trusted (0 = trust none). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
});

export type Config = z.infer<typeof schema> & {
  corsOrigins: string[];
  match: MatchSettings;
  rescue: RescueSettings;
  rateLimits: Record<RateLimitName, RateLimitRule>;
  privilegeCheck: 'enforce' | 'warn';
  escalation: EscalationSettings;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const cfg = parsed.data;
  const corsOrigins = cfg.CORS_ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (corsOrigins.includes('*')) throw new Error('CORS_ALLOWED_ORIGINS must be an explicit allow-list, not "*"');
  if (cfg.NODE_ENV === 'production' && !cfg.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be "true" in production');
  }
  if (cfg.NODE_ENV === 'production') {
    if (cfg.DB_PRIVILEGE_CHECK === 'warn') throw new Error('DB_PRIVILEGE_CHECK must be "enforce" in production');
    if (!cfg.RATE_LIMIT_ENABLED) throw new Error('RATE_LIMIT_ENABLED must be "true" in production');
    // The privileged URL belongs to operator commands. If it is visible to the API process and logs in as the same
    // user as the runtime URL, the two connections are not actually separated.
    if (env.MIGRATION_DATABASE_URL && sameLogin(env.MIGRATION_DATABASE_URL, cfg.DATABASE_URL)) {
      throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL use the same database login: the runtime connection must be a separate least-privilege role');
    }
  }
  const privilegeCheck = cfg.DB_PRIVILEGE_CHECK ?? (cfg.NODE_ENV === 'production' ? 'enforce' : 'warn');
  const match = loadMatchSettings(env);
  const escalation = loadEscalationSettings(env);
  return { ...cfg, corsOrigins, match, rescue: loadRescueSettings(env), rateLimits: loadRateLimits(env), privilegeCheck, escalation };
}
