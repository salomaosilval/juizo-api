import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(argon2);

const ALGORITHM = 'argon2id';
const ARGON2_VERSION = 19;
const MEMORY_IN_KIBIBYTES = 65_536;
const PASSES = 3;
const PARALLELISM = 1;
const SALT_LENGTH_IN_BYTES = 16;
const HASH_LENGTH_IN_BYTES = 32;

const PASSWORD_NORMALIZATION_FORM = 'NFKC';

const HASH_FORMAT = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w+/-]+)\$([\w+/-]+)$/;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, storedHash: string): Promise<boolean>;
}

export function createPasswordHasher(): PasswordHasher {
  return {
    async hash(password) {
      const salt = randomBytes(SALT_LENGTH_IN_BYTES);
      const derivedKey = await deriveKey(ALGORITHM, {
        message: password.normalize(PASSWORD_NORMALIZATION_FORM),
        nonce: salt,
        memory: MEMORY_IN_KIBIBYTES,
        passes: PASSES,
        parallelism: PARALLELISM,
        tagLength: HASH_LENGTH_IN_BYTES,
      });
      const parameters = `m=${MEMORY_IN_KIBIBYTES},t=${PASSES},p=${PARALLELISM}`;
      return `$${ALGORITHM}$v=${ARGON2_VERSION}$${parameters}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
    },

    async verify(password, storedHash) {
      const match = HASH_FORMAT.exec(storedHash);
      if (!match) {
        return false;
      }
      const [, memory, passes, parallelism, encodedSalt, encodedKey] = match;
      const expectedKey = Buffer.from(encodedKey ?? '', 'base64url');
      const derivedKey = await deriveKey(ALGORITHM, {
        message: password.normalize(PASSWORD_NORMALIZATION_FORM),
        nonce: Buffer.from(encodedSalt ?? '', 'base64url'),
        memory: Number(memory),
        passes: Number(passes),
        parallelism: Number(parallelism),
        tagLength: expectedKey.length,
      });
      return timingSafeEqual(derivedKey, expectedKey);
    },
  };
}
