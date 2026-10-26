export const DIETARY_TAGS = [
  'VEGETARIAN',
  'VEGAN',
  'HALAL',
  'JAIN',
  'GLUTEN_FREE',
  'CONTAINS_NUTS',
  'CONTAINS_DAIRY',
  'CONTAINS_EGG',
] as const;
export type DietaryTag = (typeof DIETARY_TAGS)[number];

/** A published listing must leave at least this long before its pickup deadline. */
export const MIN_PICKUP_NOTICE_MINUTES = 15;
/** Clock-skew allowance when checking that food was not "prepared in the future". */
export const PREPARED_AT_GRACE_MINUTES = 5;

/** The provider confirms this at publish time (spec 1.3). FoodLoop does not certify food safety. */
export const DECLARATION_TEXT =
  'I confirm the food was prepared within the stated time, has been stored appropriately, is not partially consumed, ' +
  'has intact packaging where applicable, and that I have listed any known dietary and allergen information.';

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export type Urgency = 'NORMAL' | 'PRIORITY' | 'URGENT' | 'CRITICAL' | 'EXPIRED';

/** Urgency buckets from the spec (Appendix A), derived from remaining pickup time. */
export function urgencyFor(pickupDeadline: Date, now: Date): Urgency {
  const minutes = (pickupDeadline.getTime() - now.getTime()) / 60_000;
  if (minutes <= 0) return 'EXPIRED';
  if (minutes < 30) return 'CRITICAL';
  if (minutes < 60) return 'URGENT';
  if (minutes <= 120) return 'PRIORITY';
  return 'NORMAL';
}
