export type FoodCategory = 'COOKED_MEALS' | 'BAKERY' | 'PRODUCE' | 'PACKAGED_FOOD' | 'DAIRY' | 'BEVERAGES' | 'OTHER';
export type Packaging = 'INDIVIDUAL_BOXES' | 'BULK_CONTAINERS' | 'WRAPPED' | 'LOOSE' | 'OTHER';
export type ListingStatus = 'DRAFT' | 'AVAILABLE' | 'CANCELLED' | 'EXPIRED' | 'RESERVED' | 'COLLECTED';
export type Urgency = 'NORMAL' | 'PRIORITY' | 'URGENT' | 'CRITICAL' | 'EXPIRED';

export const foodCategoryLabels: Record<FoodCategory, string> = {
  COOKED_MEALS: 'Cooked meals',
  BAKERY: 'Bakery',
  PRODUCE: 'Fruit and vegetables',
  PACKAGED_FOOD: 'Packaged food',
  DAIRY: 'Dairy',
  BEVERAGES: 'Beverages',
  OTHER: 'Other',
};
export const FOOD_CATEGORIES = Object.keys(foodCategoryLabels) as FoodCategory[];

export const packagingLabels: Record<Packaging, string> = {
  INDIVIDUAL_BOXES: 'Individual boxes',
  BULK_CONTAINERS: 'Bulk containers',
  WRAPPED: 'Wrapped / sealed',
  LOOSE: 'Loose',
  OTHER: 'Other',
};
export const PACKAGING_TYPES = Object.keys(packagingLabels) as Packaging[];

export const dietaryTagLabels: Record<string, string> = {
  VEGETARIAN: 'Vegetarian',
  VEGAN: 'Vegan',
  HALAL: 'Halal',
  JAIN: 'Jain',
  GLUTEN_FREE: 'Gluten free',
  CONTAINS_NUTS: 'Contains nuts',
  CONTAINS_DAIRY: 'Contains dairy',
  CONTAINS_EGG: 'Contains egg',
};
export const DIETARY_TAGS = Object.keys(dietaryTagLabels);

/** Full listing as seen by the owning provider (includes the exact pickup address). */
export interface Listing {
  id: string;
  title: string;
  description: string | null;
  foodCategory: FoodCategory;
  servings: number;
  estimatedKg: number | null;
  preparedAt: string;
  pickupStart: string;
  pickupDeadline: string;
  addressLine: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
  packaging: Packaging;
  dietaryTags: string[];
  allergenNotes: string | null;
  transportRequired: boolean;
  hasImage: boolean;
  status: ListingStatus;
  urgency: Urgency | null;
  editable: boolean;
  declarationAcceptedAt: string | null;
  publishedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Pre-acceptance view for NGOs: approximate area only. */
export interface PublicListing {
  id: string;
  providerName: string;
  title: string;
  description: string | null;
  foodCategory: FoodCategory;
  servings: number;
  estimatedKg: number | null;
  preparedAt: string;
  pickupStart: string;
  pickupDeadline: string;
  approximateArea: { city: string; latitude: number | null; longitude: number | null };
  packaging: Packaging;
  dietaryTags: string[];
  allergenNotes: string | null;
  transportRequired: boolean;
  hasImage: boolean;
  urgency: Urgency;
  publishedAt: string;
}

export interface ListingEvent {
  id: string;
  action: 'PUBLISHED' | 'CANCELLED' | 'EXPIRED';
  reason: string | null;
  createdAt: string;
}

export interface Requirement {
  id: string;
  foodCategories: FoodCategory[];
  neededServings: number;
  capacityServings: number;
  serviceRadiusKm: number;
  availableFrom: string;
  availableTo: string;
  dietaryMustHave: string[];
  dietaryMustAvoid: string[];
  intakeEnabled: boolean;
  active: boolean;
  acceptingNow: boolean;
  updatedAt: string;
}

export const listingImageUrl = (id: string) => `/api/v1/listings/${id}/image`;

/** `<input type="datetime-local">` uses local time without a zone; the API wants an absolute ISO instant. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Human text for the time left, e.g. "2 h 15 min left". Never relies on color. */
export function timeLeftText(deadlineIso: string, now: number): string {
  const ms = new Date(deadlineIso).getTime() - now;
  if (ms <= 0) return 'Expired';
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return 'Less than 1 min left';
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d} d ${h} h left`;
  if (h > 0) return `${h} h ${m} min left`;
  return `${m} min left`;
}

export const urgencyLabels: Record<Urgency, string> = {
  NORMAL: 'Normal',
  PRIORITY: 'Priority',
  URGENT: 'Urgent',
  CRITICAL: 'Critical',
  EXPIRED: 'Expired',
};

/* ------------------------------ matching (recommendations only) ------------------------------ */

export interface ScoreComponent {
  /** 0-100 */
  score: number;
  /** Weight in percent. */
  weight: number;
  /** Contribution to the total score. */
  points: number;
}
export interface Breakdown {
  distance: ScoreComponent;
  urgency: ScoreComponent;
  quantity: ScoreComponent;
  need: ScoreComponent;
  reliability: ScoreComponent;
}
export const breakdownLabels: Record<keyof Breakdown, string> = {
  distance: 'Distance',
  urgency: 'Time feasibility',
  quantity: 'Quantity fit',
  need: 'Active need',
  reliability: 'Reliability',
};

export interface EstimateInfo {
  basis: string;
  roadDistanceFactor: number;
  avgSpeedKmh: number;
  dispatchBufferMinutes: number;
  searchRadiusKm: number;
  note: string;
}

export interface MatchInfo {
  score: number | null;
  rankAmongCandidates: number | null;
  breakdown: Breakdown;
  reasons: string[];
  estimatedDistanceKm: number | null;
  estimatedTravelMinutes: number | null;
  estimatedMarginMinutes: number | null;
}

export type RecommendedListing = PublicListing & { match: MatchInfo };
export type RecommendationState = 'ACTIVE' | 'NO_REQUIREMENT' | 'PAUSED' | 'WINDOW_ENDED' | 'NO_COORDINATES';

export interface ProviderCandidate {
  rank: number;
  organizationId: string;
  organizationName: string;
  city: string | null;
  score: number;
  breakdown: Breakdown;
  reasons: string[];
  estimatedDistanceKm: number | null;
  estimatedTravelMinutes: number | null;
  estimatedMarginMinutes: number | null;
  notifiedAt: string | null;
}

export interface MatchesView {
  listing: { id: string; matchable: boolean; unavailableReason: 'LISTING_NOT_AVAILABLE' | 'LISTING_NO_COORDINATES' | null; urgency: Urgency; pickupDeadline: string };
  computedAt: string | null;
  estimate: EstimateInfo;
  candidates: ProviderCandidate[];
  excluded: { code: string; message: string; count: number }[];
}

/** Bundled stock photo shown when a listing has no photo of its own. */
export const categoryPhoto: Record<FoodCategory, import('./photoCredits').PhotoName> = {
  COOKED_MEALS: 'cooked-thali',
  BAKERY: 'bakery-loaves',
  PRODUCE: 'produce-market',
  PACKAGED_FOOD: 'packaged-tiffin',
  DAIRY: 'packaged-tiffin',
  BEVERAGES: 'packaged-tiffin',
  OTHER: 'cooked-plate',
};

/**
 * Which bundled stock photo to show for a listing that has no photo of its own: by words in the title first (a "biryani" tray
 * gets a plate of rice and curry, "bread" gets loaves), then by category. Always shown with an "Illustrative photo" label.
 */
export function stockPhoto(title: string, category: FoodCategory): import('./photoCredits').PhotoName {
  const t = title.toLowerCase();
  if (/(biryani|pulao|rice|dal|curry|thali|meal|lunch|dinner|sabzi|roti)/.test(t) && category !== 'PACKAGED_FOOD') return t.includes('biryani') || t.includes('pulao') ? 'cooked-plate' : 'cooked-thali';
  if (/(bread|bun|loaf|loaves|bake|cake|pastry|roll)/.test(t)) return 'bakery-trays';
  if (/(fruit|vegetable|veg box|produce|greens)/.test(t)) return 'produce-market';
  if (/(box|boxes|packed|tiffin|snack)/.test(t)) return 'packaged-tiffin';
  return categoryPhoto[category];
}
