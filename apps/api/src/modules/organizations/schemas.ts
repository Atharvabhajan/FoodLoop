import { z } from 'zod';
import { DOCUMENT_TYPES } from '../../db/schema.js';

const text = (label: string, max: number) =>
  z.string().trim().min(1, `${label} is required.`).max(max, `${label} is too long.`);

const fields = {
  name: text('Organization name', 120).pipe(z.string().min(2, 'Organization name is too short.')),
  contactName: text('Contact name', 100),
  contactEmail: z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid contact email.')),
  contactPhone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number.'),
  addressLine: text('Address', 200),
  city: text('City', 80),
  latitude: z.number('Latitude must be a number.').min(-90).max(90).nullable(),
  longitude: z.number('Longitude must be a number.').min(-180).max(180).nullable(),
};

export const createOrganizationSchema = z
  .object({
    name: fields.name,
    contactName: fields.contactName.optional(),
    contactEmail: fields.contactEmail.optional(),
    contactPhone: fields.contactPhone.optional(),
    addressLine: fields.addressLine.optional(),
    city: fields.city.optional(),
    latitude: fields.latitude.optional(),
    longitude: fields.longitude.optional(),
  })
  .strict();

export const updateOrganizationSchema = createOrganizationSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update.');

export const uploadFieldsSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES, 'Choose a document type.'),
});

export const decisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_RESUBMISSION'], 'Choose a decision.'),
    reason: z.string().trim().max(1000, 'Reason is too long.').optional(),
    submissionNumber: z.number().int().positive('submissionNumber is required.'),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.decision === 'REJECT' || v.decision === 'REQUEST_RESUBMISSION') && !v.reason) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A reason is required to reject or request resubmission.',
      });
    }
  });

export const uuidParam = z.uuid();
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type DecisionInput = z.infer<typeof decisionSchema>;
