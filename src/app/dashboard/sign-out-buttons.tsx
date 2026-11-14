"use client";

import { useState } from "react";

const buttonClass =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900";

export function SignOutButtons() {
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut(everywhere: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(everywhere ? "/api/auth/logout-all" : "/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      // 401 means the session had already ended, which is also fine: the goal is "signed out".
      if (response.ok || response.status === 401) {
        // A full page load on purpose (not router.push): it throws away everything the browser
        // cached for the signed-in pages, so "Back" cannot show them after signing out.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/login");
        return;
      }
      setError("Could not sign out. Please try again.");
    } catch {
      setError("Could not reach the server. Please try again.");
    }
    setBusy(false);
    setConfirmAll(false);
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => signOut(false)}>
          Sign out
        </button>
        {confirmAll ? (
          <button
            type="button"
            className={`${buttonClass} border-red-300 text-red-800 dark:border-red-800 dark:text-red-300`}
            disabled={busy}
            onClick={() => signOut(true)}
          >
            Confirm: sign out everywhere
          </button>
        ) : (
          <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirmAll(true)}>
            Sign out everywhere
          </button>
        )}
      </div>
      <p role="alert" className="min-h-4 text-sm text-red-700 dark:text-red-300">
        {error}
      </p>
    </div>
  );
}
