import { z } from 'zod';

/**
 * Partial version of an object schema for PATCH bodies. `.partial()` keeps field defaults,
 * so a missing field would be filled with its default and overwrite the stored value.
 */
export function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const f = field as z.ZodType;
    shape[key] = (f instanceof z.ZodDefault ? (f.unwrap() as z.ZodType) : f).optional();
  }
  return z.object(shape) as unknown as z.ZodObject<{
    [K in keyof S]: z.ZodOptional<S[K] extends z.ZodDefault<infer I> ? I : S[K]>;
  }>;
}
