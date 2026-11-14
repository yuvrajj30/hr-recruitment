// Two errors the rest of the app throws when a request is not allowed.
// The route wrapper (Phase 5) turns them into 401 / 403 answers.
// The message is deliberately generic; `detail` is for the server log only and is never sent to the browser.

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "unauthorized" | "forbidden",
    readonly detail?: string,
  ) {
    super(code);
    this.name = "AuthError";
  }
}

// "You are not signed in."
export class UnauthorizedError extends AuthError {
  constructor(detail?: string) {
    super(401, "unauthorized", detail);
    this.name = "UnauthorizedError";
  }
}

// "You are signed in, but not allowed to do this."
export class ForbiddenError extends AuthError {
  constructor(detail?: string) {
    super(403, "forbidden", detail);
    this.name = "ForbiddenError";
  }
}
