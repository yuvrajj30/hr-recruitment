import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/ui/cn";

export function EmptyState({ icon: Icon, title, description, action, className }: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-10 text-center", className)}>
      <span className="flex size-10 items-center justify-center rounded-full bg-surface-muted text-fg-muted">
        <Icon className="size-5" aria-hidden />
      </span>
      <h3 className="mt-3 text-sm font-semibold text-fg">{title}</h3>
      <p className="mt-1 max-w-sm text-[13px] text-fg-muted">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
