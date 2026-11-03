import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const PERSISTENCE_IMPORTS = {
  group: ['**/generated/**', '**/shared/database/**', '@prisma/*'],
  message: 'Only repositories and the composition root may touch the persistence layer.',
};

const MODULE_INTERNALS = {
  regex: '^\\.\\./(?!\\.\\.)[^/]+/(?!index\\.js$)',
  message: 'Import other modules only through their public index.ts.',
};

export default defineConfig([
  globalIgnores(['dist/', 'coverage/', 'src/generated/']),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['src/modules/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [MODULE_INTERNALS] }],
    },
  },
  {
    files: ['src/modules/**/*.routes.ts', 'src/modules/**/*.service.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [MODULE_INTERNALS, PERSISTENCE_IMPORTS] },
      ],
    },
  },
  {
    files: ['src/modules/**/*.service.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            MODULE_INTERNALS,
            PERSISTENCE_IMPORTS,
            { group: ['fastify'], message: 'Services must not depend on the HTTP layer.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\./modules/[^/]+/(?!index\\.js$)',
              message: 'Import modules only through their public index.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['**/modules/**'], message: 'Shared code must not import modules.' }],
        },
      ],
    },
  },
  {
    files: ['src/modules/auth/google-identity-provider.test.ts'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off',
    },
  },
  prettier,
]);
