import { z } from 'zod';
import { FOOD_CATEGORIES } from '../../db/schema.js';
import { DIETARY_TAGS } from '../listings/constants.js';

const instant = (label: string) =>
  z.iso.datetime({ offset: true, message: `${label} must be a valid date and time.` }).transform((v) => new Date(v));

const fields = {
  foodCategories: z
    .array(z.enum(FOOD_CATEGORIES, 'Unknown food category.'))
    .min(1, 'Choose at least one food category.')
    .max(FOOD_CATEGORIES.length)
    .refine((c) => new Set(c).size === c.length, 'Food categories must be unique.'),
  neededServings: z
    .number('Servings needed must be a number.')
    .int('Servings needed must be a whole number.')
    .positive('Servings needed must be greater than zero.')
    .max(1_000_000, 'Servings needed is too large.'),
  capacityServings: z
    .number('Capacity must be a number.')
    .int('Capacity must be a whole number.')
    .positive('Capacity must be greater than zero.')
    .max(1_000_000, 'Capacity is too large.'),
  serviceRadiusKm: z
    .number('Service radius must be a number.')
    .positive('Service radius must be greater than zero.')
    .max(100, 'Service radius cannot exceed 100 km.'),
  availableFrom: instant('Availability start'),
  availableTo: instant('Availability end'),
  dietaryMustHave: z
    .array(z.enum(DIETARY_TAGS, 'Unknown dietary tag.'))
    .max(DIETARY_TAGS.length)
    .refine((t) => new Set(t).size === t.length, 'Dietary tags must be unique.'),
  dietaryMustAvoid: z
    .array(z.enum(DIETARY_TAGS, 'Unknown dietary tag.'))
    .max(DIETARY_TAGS.length)
    .refine((t) => new Set(t).size === t.length, 'Dietary tags must be unique.'),
};

export const createRequirementSchema = z
  .object({
    foodCategories: fields.foodCategories,
    neededServings: fields.neededServings,
    capacityServings: fields.capacityServings,
    serviceRadiusKm: fields.serviceRadiusKm,
    availableFrom: fields.availableFrom,
    availableTo: fields.availableTo,
    dietaryMustHave: fields.dietaryMustHave.default([]),
    dietaryMustAvoid: fields.dietaryMustAvoid.default([]),
    intakeEnabled: z.boolean().default(true),
  })
  .strict();

export const updateRequirementSchema = z
  .object({
    foodCategories: fields.foodCategories,
    neededServings: fields.neededServings,
    capacityServings: fields.capacityServings,
    serviceRadiusKm: fields.serviceRadiusKm,
    availableFrom: fields.availableFrom,
    availableTo: fields.availableTo,
    dietaryMustHave: fields.dietaryMustHave,
    dietaryMustAvoid: fields.dietaryMustAvoid,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update.');

export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;
export type UpdateRequirementInput = z.infer<typeof updateRequirementSchema>;
