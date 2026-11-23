import type { ComponentProps } from "react";
import { cn } from "@/lib/ui/cn";
import { focusRing } from "./focus";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "block h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-[15px] text-fg placeholder:text-fg-subtle sm:h-9 sm:text-sm",
        "disabled:opacity-60 aria-invalid:border-danger",
        focusRing,
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "block min-h-24 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[15px] text-fg placeholder:text-fg-subtle sm:text-sm",
        "disabled:opacity-60 aria-invalid:border-danger",
        focusRing,
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "block h-10 w-full rounded-md border border-border-strong bg-surface px-2.5 text-[15px] text-fg sm:h-9 sm:text-sm",
        "disabled:opacity-60 aria-invalid:border-danger",
        focusRing,
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("block text-[13px] font-medium text-fg", className)} {...props} />;
}
