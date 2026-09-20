import { z } from 'zod';

/** The flat JSON Schema subset a migration target may use (see docs/api.md). */
export const property = z
  .object({
    type: z.enum(['string', 'number', 'integer', 'boolean']),
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    format: z.enum(['email', 'date']).optional(),
    enum: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1)
      .max(100)
      .optional(),
    pattern: z.string().max(300).optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().max(2000).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    /** Confirmed source-column synonyms; matched before any AI is consulted. */
    'x-aliases': z.array(z.string().max(120)).max(50).optional(),
    /** Source value → canonical enum value, applied during safe cleanup. */
    'x-value-aliases': z.record(z.string(), z.string()).optional(),
    /** Values must be unique across records (in addition to the identity field). */
    'x-unique': z.boolean().optional(),
  })
  .strict();
export type Property = z.infer<typeof property>;

export const schemaSpec = z
  .object({
    $schema: z.string().optional(),
    $id: z.string().optional(),
    title: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    type: z.literal('object'),
    additionalProperties: z.literal(false),
    required: z.array(z.string()),
    properties: z.record(z.string(), property),
  })
  .strict();
export type TargetSchema = z.infer<typeof schemaSpec>;
