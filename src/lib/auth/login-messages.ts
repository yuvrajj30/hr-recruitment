// Pure helpers for the login form: turn the server's answer into a message a person can act on.
// No Next.js or database code here, so the browser can use it and tests can check every case.

export const NETWORK_ERROR_MESSAGE = "Could not reach the server. Check your connection and try again.";
export const GENERIC_ERROR_MESSAGE = "Something went wrong on our side. Please try again in a moment.";
export const SESSION_ENDED_MESSAGE = "Your session has ended. Please sign in again.";

export type LoginOutcome = { kind: "success"; redirectTo: string } | { kind: "error"; message: string };

// "895 seconds" -> "15 minutes". Always rounds UP, so we never tell someone to retry too early.
export function formatWait(seconds: unknown): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "a few minutes";
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

// Even though the server already cleans the destination, the browser double-checks:
// only a plain path inside this app is ever navigated to.
export function safeDestination(value: unknown, fallback = "/dashboard"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value;
}

export function interpretLoginResponse(status: number, body: unknown): LoginOutcome {
  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (status === 200) return { kind: "success", redirectTo: safeDestination(data.redirectTo) };
  // The server answers identically for "wrong password" and "no such account" on purpose,
  // and so does this message.
  if (status === 401) return { kind: "error", message: "That email and password do not match. Check them and try again." };
  if (status === 429) {
    return { kind: "error", message: `Too many sign-in attempts. Please wait ${formatWait(data.retryAfterSeconds)} and try again.` };
  }
  if (status === 403) return { kind: "error", message: "This request was blocked for safety. Reload the page and try again." };
  if (status === 400) return { kind: "error", message: "Enter your email address and your password." };
  return { kind: "error", message: GENERIC_ERROR_MESSAGE };
}

// Quick check before sending, so an empty form does not use up a sign-in attempt.
export function checkLoginInput(email: string, password: string): string | null {
  if (email.trim().length === 0 || password.length === 0) return "Enter your email address and your password.";
  if (!email.includes("@")) return "Enter a valid email address.";
  return null;
}
