import { z } from 'zod';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long.')
  .pipe(z.email('Enter a valid email address.'));

const password = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 72, 'Password is too long.')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Password must include a letter and a number.');

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters.').max(100, 'Name is too long.'),
    email,
    password,
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number.')
      .optional(),
    role: z.enum(['provider', 'ngo', 'runner'], 'Choose how you will use FoodLoop.'),
    organizationName: z.string().trim().min(2, 'Organization name is too short.').max(120).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.role === 'provider' || v.role === 'ngo') && !v.organizationName) {
      ctx.addIssue({
        code: 'custom',
        path: ['organizationName'],
        message: 'Organization name is required for providers and NGOs.',
      });
    }
  });

// Login does not enforce the registration password policy: it only needs a non-empty string.
export const loginSchema = z
  .object({
    email,
    password: z.string().min(1, 'Password is required.').max(200),
  })
  .strict();

// Only name and phone can be changed here. Email, role and status are identity and permission data: never self-service.
export const accountUpdateSchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters.').max(100, 'Name is too long.').optional(),
    phone: z
      .union([
        z.literal('').transform(() => null),
        z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number.'),
        z.null(),
      ])
      .optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.phone !== undefined, 'Nothing to update.');

export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
