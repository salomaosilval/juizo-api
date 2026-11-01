export type AppErrorCode =
  | 'FORBIDDEN_ORIGIN'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_TOKEN'
  | 'NOT_FOUND'
  | 'SERVICE_UNAVAILABLE'
  | 'TOO_MANY_ATTEMPTS'
  | 'UNAUTHENTICATED';

const HTTP_STATUS_BY_CODE: Record<AppErrorCode, number> = {
  FORBIDDEN_ORIGIN: 403,
  INVALID_CREDENTIALS: 401,
  INVALID_TOKEN: 400,
  NOT_FOUND: 404,
  SERVICE_UNAVAILABLE: 503,
  TOO_MANY_ATTEMPTS: 429,
  UNAUTHENTICATED: 401,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;

  constructor(code: AppErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = HTTP_STATUS_BY_CODE[code];
  }
}
