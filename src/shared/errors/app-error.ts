export type AppErrorCode = 'NOT_FOUND' | 'SERVICE_UNAVAILABLE';

const HTTP_STATUS_BY_CODE: Record<AppErrorCode, number> = {
  NOT_FOUND: 404,
  SERVICE_UNAVAILABLE: 503,
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
