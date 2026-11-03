import { z } from 'zod';

const commaSeparatedUrls = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(z.array(z.url()));

const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value === '' ? undefined : value));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(0).max(65_535).default(3333),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    CORS_ALLOWED_ORIGINS: commaSeparatedUrls,
    RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(120),
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).optional(),
    WEB_APP_URL: z.url({ protocol: /^https?$/ }),
    EMAIL_PROVIDER: z.enum(['mailpit', 'resend']).default('mailpit'),
    EMAIL_FROM_NAME: z.string().min(1).default('Juízo'),
    EMAIL_FROM_ADDRESS: z.email(),
    MAILPIT_URL: z.url().default('http://localhost:8025'),
    GOOGLE_CLIENT_ID: optionalSecret,
    GOOGLE_CLIENT_SECRET: optionalSecret,
    GOOGLE_REDIRECT_URL: optionalSecret.pipe(z.url().optional()),
    RESEND_API_KEY: z
      .string()
      .optional()
      .transform((key) => (key === '' ? undefined : key)),
  })
  .superRefine((env, context) => {
    const { NODE_ENV, EMAIL_PROVIDER, RESEND_API_KEY, WEB_APP_URL, TRUSTED_PROXY_HOPS } = env;
    if (NODE_ENV === 'production' && TRUSTED_PROXY_HOPS === undefined) {
      context.addIssue({ code: 'custom', path: ['TRUSTED_PROXY_HOPS'], message: 'Required.' });
    }
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URL } = env;
    const googleSettings = [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URL];
    if (googleSettings.some(Boolean) && !googleSettings.every(Boolean)) {
      context.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_ID'],
        message: 'Google needs its client id, client secret and redirect URL together.',
      });
    }
    if (NODE_ENV === 'production' && GOOGLE_REDIRECT_URL?.startsWith('https://') === false) {
      context.addIssue({
        code: 'custom',
        path: ['GOOGLE_REDIRECT_URL'],
        message: 'Must use https.',
      });
    }
    if (EMAIL_PROVIDER === 'resend' && !RESEND_API_KEY) {
      context.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'Required.' });
    }
    if (NODE_ENV === 'production' && EMAIL_PROVIDER !== 'resend') {
      context.addIssue({ code: 'custom', path: ['EMAIL_PROVIDER'], message: 'Must be resend.' });
    }
    if (NODE_ENV === 'production' && !WEB_APP_URL.startsWith('https://')) {
      context.addIssue({ code: 'custom', path: ['WEB_APP_URL'], message: 'Must use https.' });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class InvalidEnvError extends Error {
  constructor(issues: readonly z.core.$ZodIssue[]) {
    const invalidKeys = issues.map((issue) => issue.path.join('.')).join(', ');
    super(`Invalid environment variables: ${invalidKeys}`);
    this.name = 'InvalidEnvError';
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new InvalidEnvError(result.error.issues);
  }
  return result.data;
}
