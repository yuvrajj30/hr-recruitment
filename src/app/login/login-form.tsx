"use client";

import { useSearchParams } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import {
  checkLoginInput,
  interpretLoginResponse,
  NETWORK_ERROR_MESSAGE,
  SESSION_ENDED_MESSAGE,
} from "@/lib/auth/login-messages";

const inputClass =
  "mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-base text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:border-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-600/40 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

export function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") ?? undefined; // the server cleans this again; it is only a hint
  const endedNotice = params.get("reason") === "expired";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailId = useId();
  const passwordId = useId();
  const messageId = useId();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return; // a double click must not use up two sign-in attempts
    const problem = checkLoginInput(email, password);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, ...(next ? { next } : {}) }),
        credentials: "same-origin",
        cache: "no-store",
      });
      const body: unknown = await response.json().catch(() => null);
      const outcome = interpretLoginResponse(response.status, body);
      if (outcome.kind === "success") {
        // A full page load, so the new cookie is used from the very first request.
        window.location.assign(outcome.redirectTo);
        return; // stay "busy" while the browser navigates
      }
      setPassword(""); // never keep a rejected password sitting in the box
      setError(outcome.message);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    }
    setBusy(false);
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="space-y-5 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
    >
      {endedNotice && !error && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="status">
          {SESSION_ENDED_MESSAGE}
        </p>
      )}

      <div>
        <label htmlFor={emailId} className="block text-sm font-medium">
          Email address
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          aria-describedby={error ? messageId : undefined}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor={passwordId} className="block text-sm font-medium">
          Password
        </label>
        <div className="relative">
          <input
            id={passwordId}
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            maxLength={1024}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            aria-describedby={error ? messageId : undefined}
            className={`${inputClass} pr-16`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-pressed={showPassword}
            className="absolute inset-y-0 right-0 mt-1 rounded-r-md px-3 text-xs font-medium text-zinc-600 hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {/* Always present so screen readers announce the message the moment it appears. */}
      <div id={messageId} role="alert" aria-live="assertive" className="min-h-0">
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}</p>}
      </div>

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-amber-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
