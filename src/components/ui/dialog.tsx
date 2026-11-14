"use client";

import { AlertDialog, Dialog } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/ui/cn";
import { Button } from "./button";

const overlay = "fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]";

// A confirmation for actions with consequences. Focus is trapped inside, Escape cancels,
// and the dialog says exactly what will happen.
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm, busy = false, tone = "danger" }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  tone?: "danger" | "primary";
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={overlay} />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[10px] border border-border bg-surface p-5 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-fg">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 text-sm text-fg-muted">{description}</div>
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" disabled={busy}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            {/* Not an AlertDialog.Action: the dialog stays open (showing progress) until the work finishes. */}
            <Button variant={tone} loading={busy} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

// A panel that slides in from the left (the navigation menu on phones).
export function SidePanel({ open, onOpenChange, title, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn("fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface shadow-xl")}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const SidePanelClose = Dialog.Close;
