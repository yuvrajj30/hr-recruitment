"use client";

import { useSearchParams } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
import { Input, Label } from "@/components/ui/input";
import {
  checkLoginInput,
  interpretLoginResponse,
  NETWORK_ERROR_MESSAGE,
  SESSION_ENDED_MESSAGE,
} from "@/lib/auth/login-messages";
import { cn } from "@/lib/ui/cn";

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
    <form onSubmit={onSubmit} noValidate className="space-y-4 rounded-[10px] border border-border bg-surface p-6 shadow-sm">
      {endedNotice && !error && <Alert tone="info">{SESSION_ENDED_MESSAGE}</Alert>}

      <div className="space-y-1.5">
        <Label htmlFor={emailId}>Email address</Label>
        <Input
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
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? messageId : undefined}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={passwordId}>Password</Label>
        <div className="relative">
          <Input
            id={passwordId}
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            maxLength={1024}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? messageId : undefined}
            className="pr-16"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-pressed={showPassword}
            className={cn("absolute inset-y-1 right-1 rounded px-2.5 text-xs font-medium text-fg-muted hover:text-fg", focusRing)}
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {/* The message itself has role="alert", so screen readers announce it the moment it appears. */}
      <div id={messageId}>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>

      <Button type="submit" loading={busy} className="w-full">
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
