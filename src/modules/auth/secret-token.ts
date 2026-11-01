import { createHash, randomBytes } from 'node:crypto';

const TOKEN_LENGTH_IN_BYTES = 32;

export function generateSecretToken(): string {
  return randomBytes(TOKEN_LENGTH_IN_BYTES).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
