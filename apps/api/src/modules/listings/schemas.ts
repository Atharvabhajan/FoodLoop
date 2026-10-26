import { z } from 'zod';
import { FOOD_CATEGORIES, PACKAGING_TYPES } from '../../db/schema.js';
import { DIETARY_TAGS } from './constants.js';

const instant = (label: string) =>
  z.iso
    .datetime({ offset: true, message: `${label} must be a valid date and time.` })
    .transform((v) => new Date(v));

const fields = {
  title: z.string().trim().min(3, 'Title must be at least 3 characters.').max(120, 'Title is too long.'),
  description: z.string().trim().max(1000, 'Description is too long.').nullable(),
  foodCategory: z.enum(FOOD_CATEGORIES, 'Choose a food category.'),
  servings: z
    .number('Servings must be a number.')
    .int('Servings must be a whole number.')
    .positive('Servings must be greater than zero.')
    .max(100_000, 'Servings is too large.'),
  estimatedKg: z.number('Weight must be a number.').positive('Weight must be greater than zero.').max(100_000).nullable(),
  preparedAt: instant('Preparation time'),
  pickupStart: instant('Pickup start'),
  pickupDeadline: instant('Pickup deadline'),
  addressLine: z.string().trim().min(3, 'Pickup address is required.').max(200, 'Address is too long.'),
  city: z.string().trim().min(2, 'City is required.').max(80, 'City is too long.'),
  latitude: z.number('Latitude must be a number.').min(-90).max(90).nullable(),
  longitude: z.number('Longitude must be a number.').min(-180).max(180).nullable(),
  packaging: z.enum(PACKAGING_TYPES, 'Choose a packaging type.'),
  dietaryTags: z
    .array(z.enum(DIETARY_TAGS, 'Unknown dietary tag.'))
    .max(DIETARY_TAGS.length)
    .refine((t) => new Set(t).size === t.length, 'Dietary tags must be unique.'),
  allergenNotes: z.string().trim().max(500, 'Allergen notes are too long.').nullable(),
  transportRequired: z.boolean('Say whether transport is required.'),
};

export const createListingSchema = z
  .object({
    title: fields.title,
    description: fields.description.optional(),
    foodCategory: fields.foodCategory,
    servings: fields.servings,
    estimatedKg: fields.estimatedKg.optional(),
    preparedAt: fields.preparedAt,
    pickupStart: fields.pickupStart,
    pickupDeadline: fields.pickupDeadline,
    addressLine: fields.addressLine,
    city: fields.city,
    latitude: fields.latitude.optional(),
    longitude: fields.longitude.optional(),
    packaging: fields.packaging,
    dietaryTags: fields.dietaryTags.default([]),
    allergenNotes: fields.allergenNotes.optional(),
    transportRequired: fields.transportRequired,
  })
  .strict();

export const updateListingSchema = z
  .object({
    title: fields.title,
    description: fields.description,
    foodCategory: fields.foodCategory,
    servings: fields.servings,
    estimatedKg: fields.estimatedKg,
    preparedAt: fields.preparedAt,
    pickupStart: fields.pickupStart,
    pickupDeadline: fields.pickupDeadline,
    addressLine: fields.addressLine,
    city: fields.city,
    latitude: fields.latitude,
    longitude: fields.longitude,
    packaging: fields.packaging,
    dietaryTags: fields.dietaryTags,
    allergenNotes: fields.allergenNotes,
    transportRequired: fields.transportRequired,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update.');

export const publishSchema = z
  .object({
    declarationAccepted: z.literal(true, 'You must confirm the food-safety declaration to publish.'),
  })
  .strict();

export const cancelSchema = z
  .object({
    reason: z.string().trim().min(3, 'A reason is required to cancel.').max(500, 'Reason is too long.'),
  })
  .strict();

export const listScopeSchema = z.enum(['active', 'past', 'all']).default('active');
export const feedQuerySchema = z.object({
  category: z.enum(FOOD_CATEGORIES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateListingInput = z.infer<typeof createListingSchema>;
export type UpdateListingInput = z.infer<typeof updateListingSchema>;
