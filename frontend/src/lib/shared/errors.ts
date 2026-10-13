// The backend's single error format:
//   {"error": {"code": "...", "message": "...", "details": [{"field", "message"}]}}
// The website's own server routes use the same format.

export type FieldError = { field: string; message: string };

export type ErrorBody = {
  error: { code: string; message: string; details?: FieldError[] };
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: FieldError[];
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string, message: string, details: FieldError[] = [],
              retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const FALLBACK_MESSAGES: Record<number, string> = {
  401: "Your session has ended. Please log in again.",
  403: "You do not have permission to do this.",
  404: "Not found.",
  413: "The upload is too large.",
  429: "Too many attempts. Please wait and try again.",
};

function isFieldError(value: unknown): value is FieldError {
  return typeof value === "object" && value !== null
    && typeof (value as FieldError).field === "string"
    && typeof (value as FieldError).message === "string";
}

export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

/** Turn any error response into an ApiError, never showing raw server output. */
export function toApiError(status: number, body: unknown, retryAfter?: string | null): ApiError {
  const retry = parseRetryAfter(retryAfter);
  const error = (body as Partial<ErrorBody> | null)?.error;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    const details = Array.isArray(error.details) ? error.details.filter(isFieldError) : [];
    return new ApiError(status, error.code, error.message, details, retry);
  }
  const message = FALLBACK_MESSAGES[status]
    ?? (status >= 500 ? "Something went wrong on the server. Please try again." : "The request failed.");
  return new ApiError(status, status >= 500 ? "SERVER_ERROR" : "REQUEST_FAILED", message, [], retry);
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/** A user-facing sentence, including when to retry after a rate limit. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429 && error.retryAfterSeconds) {
      const minutes = Math.ceil(error.retryAfterSeconds / 60);
      return `${error.message} Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    }
    return error.message;
  }
  return "Something went wrong. Please check your connection and try again.";
}
