"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { focusRing } from "@/components/ui/focus";
import { Tooltip } from "@/components/ui/tooltip";
import type { OrganizationSummary } from "@/lib/auth/organizations";
import { cn } from "@/lib/ui/cn";

// Shows the active organisation. With more than one organisation it becomes a menu to switch.
// Switching uses the existing, permission-checked POST /api/auth/organization.
export function OrgSwitcher({ current, organizations, compact = false }: {
  current: OrganizationSummary | null;
  organizations: OrganizationSummary[];
  compact?: boolean;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = current?.name ?? "No organisation";
  const canSwitch = organizations.length > 1;

  async function switchTo(id: string) {
    if (busyId || id === current?.id) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/auth/organization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: id }),
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.ok) {
        // A full page load, so every screen is rebuilt for the new organisation and nothing from the old one remains.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/dashboard");
        return;
      }
      setError(res.status === 401 ? "Your session has ended. Please sign in again." : "Could not switch organisation. Please try again.");
    } catch {
      setError("Could not reach the server. Please try again.");
    }
    setBusyId(null);
  }

  const face = (
    <span className={cn("flex min-w-0 items-center gap-2.5", compact && "justify-center")}>
      <Avatar name={name} shape="square" />
      {!compact && (
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-[13px] font-semibold text-fg">{name}</span>
          {canSwitch && <span className="block text-[11px] text-fg-subtle">Switch organisation</span>}
        </span>
      )}
      {!compact && canSwitch && <ChevronsUpDown className="size-4 shrink-0 text-fg-subtle" aria-hidden />}
    </span>
  );

  if (!canSwitch) {
    return compact ? (
      <Tooltip content={name}>
        <span tabIndex={0} aria-label={name} className={cn("flex justify-center rounded-md p-1", focusRing)}>
          {face}
        </span>
      </Tooltip>
    ) : (
      <div className="px-2 py-1.5">{face}</div>
    );
  }

  return (
    <div>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Organisation: ${name}. Switch organisation`}
          className={cn("w-full rounded-md px-2 py-1.5 hover:bg-surface-muted", focusRing)}
        >
          {face}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">Organisations</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {organizations.map((org) => (
            <DropdownMenuItem key={org.id} disabled={busyId !== null} onSelect={() => switchTo(org.id)}>
              <Avatar name={org.name} shape="square" size="sm" />
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
              {org.id === current?.id && <Check className="text-accent!" aria-label="Current organisation" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <Alert tone="danger" className="mt-2">
          {error}
        </Alert>
      )}
    </div>
  );
}
