import { z } from 'zod';

export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  issues: z
    .array(
      z.object({
        path: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
