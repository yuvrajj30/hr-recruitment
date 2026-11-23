// Errors the recruitment services throw for requests that are understood but cannot be done.
// Their messages are written for the person using the app and are safe to show.
// (Not signed in / not allowed is still ForbiddenError / UnauthorizedError from the auth layer.)

export class RecruitmentError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "conflict" | "duplicate" | "closed",
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "RecruitmentError";
  }
}

export const notFound = (what = "That record") => new RecruitmentError("not_found", `${what} was not found. It may have been removed.`);
export const invalid = (message: string, fieldErrors?: Record<string, string>) => new RecruitmentError("invalid", message, fieldErrors);
export const conflict = (message: string) => new RecruitmentError("conflict", message);
// The same person applying to the same job twice.
export const duplicate = (message: string) => new RecruitmentError("duplicate", message);
// The job is not accepting applications (not published, closed, archived or past its deadline).
export const closed = (message: string) => new RecruitmentError("closed", message);
