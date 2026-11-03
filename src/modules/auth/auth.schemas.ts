import { z } from 'zod';

const MAX_TOKEN_LENGTH = 128;
const MAX_NAME_LENGTH = 80;
const CONTROL_CHARACTERS = /\p{Cc}/u;

export const tokenSchema = z.string().min(1).max(MAX_TOKEN_LENGTH);

export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NAME_LENGTH)
  .refine((name) => !CONTROL_CHARACTERS.test(name));

export const userResponseSchema = z.object({
  user: z.object({ id: z.uuid(), name: z.string(), email: z.email() }),
});
