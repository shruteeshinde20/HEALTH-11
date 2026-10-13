// Validation messages from the API, by form field ("body.email" -> "email").

import { ApiError } from "../shared/errors.ts";

export function fieldErrors(error: unknown): Record<string, string> {
  const found: Record<string, string> = {};
  if (!(error instanceof ApiError)) return found;
  for (const detail of error.details) {
    const field = detail.field.replace(/^body\./, "");
    if (!(field in found)) found[field] = detail.message;
  }
  return found;
}
