import { describe, expect, it } from 'vitest';
import { createPasswordHasher } from './password-hasher.js';

const hasher = createPasswordHasher();

describe('PasswordHasher', () => {
  it('stores argon2id with its parameters and never the password', async () => {
    const hash = await hasher.hash('correct horse battery');

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(hash).not.toContain('correct horse battery');
  });

  it('accepts the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct horse battery');

    await expect(hasher.verify('correct horse battery', hash)).resolves.toBe(true);
    await expect(hasher.verify('wrong horse battery', hash)).resolves.toBe(false);
  });

  it('salts each hash, so equal passwords produce different hashes', async () => {
    const [first, second] = await Promise.all([
      hasher.hash('correct horse battery'),
      hasher.hash('correct horse battery'),
    ]);

    expect(first).not.toBe(second);
  });

  it('accepts the same password typed with a different Unicode composition', async () => {
    const hash = await hasher.hash('senha-com-ação'.normalize('NFC'));

    await expect(hasher.verify('senha-com-ação'.normalize('NFD'), hash)).resolves.toBe(true);
  });

  it('rejects a stored value in an unknown format', async () => {
    await expect(hasher.verify('any password', 'plain-text-value')).resolves.toBe(false);
  });
});
