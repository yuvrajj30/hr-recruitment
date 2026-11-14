import "server-only";
import { unstable_rethrow } from "next/navigation";
import { AuthError } from "@/lib/auth/errors";
import { EnvError } from "@/lib/env";
import { logger } from "@/lib/security/logger";
import { errorResponse } from "./responses";

// Wraps a route so that ANY real failure ends as a clean, generic answer:
//   - AuthError (not signed in / not allowed)  -> 401 / 403
//   - anything unexpected                       -> 500 {"error":"server_error"}
// Unexpected errors are logged by NAME and a short error code only. Their messages can contain query text,
// email addresses or connection details, so those never reach the log or the browser.

// Short machine codes such as a Postgres "23505" or Node's "ECONNREFUSED" help find the cause.
// Anything that does not look like such a code is dropped. (The log's own redaction hides keys
// containing the word "code", so the field is called failureKind.)
function failureKind(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,24}$/.test(code) ? code : undefined;
}

export function guarded(name: string, handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      return await handler(request);
    } catch (error) {
      // Next.js uses thrown signals internally (for example "this page needs a live request").
      // They are not failures and must pass through untouched; ordinary errors continue below.
      unstable_rethrow(error);
      if (error instanceof AuthError) return errorResponse(error.code, error.status);
      logger.error("auth.route_failed", {
        route: name,
        errorName: error instanceof Error ? error.name : typeof error,
        failureKind: failureKind(error),
        // A settings problem names the setting, never its value, so the message helps and is safe.
        ...(error instanceof EnvError ? { problem: error.message } : {}),
      });
      return errorResponse("server_error", 500);
    }
  };
}
