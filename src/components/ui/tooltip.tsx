"use client";

import { Tooltip as T } from "radix-ui";
import type { ReactNode } from "react";

export const TooltipProvider = T.Provider;

// A short label shown on hover and on keyboard focus (used for icon-only buttons and links).
export function Tooltip({ content, children, side = "right" }: { content: string; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={8} className="z-50 rounded-md bg-fg px-2 py-1 text-xs font-medium text-background shadow-md">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
