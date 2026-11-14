"use client";

import { DropdownMenu as Menu } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/ui/cn";

// Keyboard support (arrows, Enter, Escape, type-to-find) and focus handling come from Radix.
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export function DropdownMenuContent({ className, sideOffset = 6, align = "end", ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "z-50 min-w-56 overflow-hidden rounded-[10px] border border-border bg-surface p-1 text-sm text-fg shadow-lg",
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({ className, tone = "default", ...props }: ComponentProps<typeof Menu.Item> & { tone?: "default" | "danger" }) {
  return (
    <Menu.Item
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-[13px] outline-none select-none [&_svg]:size-4 [&_svg]:text-fg-subtle",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-muted",
        tone === "danger" && "text-danger [&_svg]:text-danger",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return <Menu.Label className={cn("px-2.5 py-2", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}
