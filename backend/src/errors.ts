const errors = {
  invalid_request: [400, "The request is malformed."],
  invalid_project_id: [400, "Project IDs must be canonical lowercase UUIDs."],
  invalid_cursor: [400, "The page cursor is invalid."],
  invalid_origin: [403, "Invalid request origin."],
  unauthenticated: [401, "Sign in to continue."],
  account_changed: [
    409,
    "The active account changed. Check your session before syncing.",
  ],
  cloud_saving_disabled: [409, "Cloud saving is disabled for this project."],
  project_not_found: [404, "Project not found."],
  project_id_conflict: [409, "This project ID is unavailable."],
  unsupported_schema: [426, "This project schema version is not supported."],
  invalid_update: [400, "Expected a complete Yjs V1 binary update."],
  invalid_schema: [422, "The document does not match schema v1."],
  resource_limit: [413, "The update or document exceeds a resource limit."],
  update_id_conflict: [
    409,
    "This update ID already identifies different bytes.",
  ],
  baseline_required: [
    409,
    "The replay cursor was compacted. Persist a fresh baseline before continuing.",
  ],
  project_quarantined: [
    409,
    "This document requires recovery before further editing.",
  ],
  unavailable: [503, "Projects are temporarily unavailable. Please retry."],
  rate_limited: [429, "Too many requests. Retry after the indicated delay."],
} as const;

export type ErrorCode = keyof typeof errors;

export class ApiError extends Error {
  constructor(readonly code: ErrorCode) {
    super(errors[code][1]);
    this.name = "ApiError";
  }

  response() {
    return Response.json(
      { error: { code: this.code, message: this.message } },
      { status: errors[this.code][0] },
    );
  }
}

export class AuthError extends Error {
  constructor(readonly kind: "unauthorized" | "unavailable") {
    super(kind);
    this.name = "AuthError";
  }

  response() {
    return Response.json(
      {
        error:
          this.kind === "unauthorized"
            ? "Sign in to continue."
            : "Authentication is temporarily unavailable. Please retry.",
      },
      { status: this.kind === "unauthorized" ? 401 : 503 },
    );
  }
}

export function projectError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof AuthError)
    return new ApiError(
      error.kind === "unauthorized" ? "unauthenticated" : "unavailable",
    );
  // Database errors may include credentials or document contents.
  return new ApiError("unavailable");
}
