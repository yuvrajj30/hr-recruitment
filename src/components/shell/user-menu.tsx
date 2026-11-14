"use client";

import { ChevronDown, LogOut, MonitorX } from "lucide-react";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { ConfirmDialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { focusRing } from "@/components/ui/focus";
import { cn } from "@/lib/ui/cn";

export function UserMenu({ name, email }: { name: string; email: string }) {
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut(everywhere: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(everywhere ? "/api/auth/logout-all" : "/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      // 401 means the session had already ended, which is also "signed out".
      if (res.ok || res.status === 401) {
        // A full page load on purpose: it throws away everything cached for signed-in pages.
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
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Account menu for ${name}`}
          className={cn("flex items-center gap-2 rounded-full p-0.5 pr-1 hover:bg-surface-muted sm:rounded-md sm:pr-2", focusRing)}
        >
          <Avatar name={name} />
          <span className="hidden max-w-40 truncate text-[13px] font-medium text-fg sm:block">{name}</span>
          <ChevronDown className="hidden size-4 text-fg-subtle sm:block" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>
            <span className="block truncate text-[13px] font-semibold text-fg">{name}</span>
            <span className="block truncate text-xs font-normal text-fg-muted">{email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={busy} onSelect={() => signOut(false)}>
            <LogOut aria-hidden />
            Sign out
          </DropdownMenuItem>
          <DropdownMenuItem tone="danger" disabled={busy} onSelect={() => setConfirmAll(true)}>
            <MonitorX aria-hidden />
            Sign out of all devices
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirmAll}
        onOpenChange={(open) => !busy && setConfirmAll(open)}
        title="Sign out of all devices?"
        description="Every place where you are signed in, including this browser, will be signed out. You will need your password to sign in again."
        confirmLabel="Sign out everywhere"
        busy={busy}
        onConfirm={() => signOut(true)}
      />

      {error && (
        <div className="fixed right-4 bottom-4 z-50 w-80 max-w-[calc(100vw-2rem)] shadow-lg">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </>
  );
}
