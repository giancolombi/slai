import type { ApiError as ApiErrorBody } from "@slai/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Thrown anywhere in a handler; rendered as `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  body(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "invalid_request", message, details);
export const unauthorized = (code = "unauthorized", message = "Not signed in.") => new ApiError(401, code, message);
export const forbidden = (message = "You do not have permission to do that.", code = "forbidden") =>
  new ApiError(403, code, message);
export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found.`);
export const conflict = (message: string, code = "conflict") => new ApiError(409, code, message);
