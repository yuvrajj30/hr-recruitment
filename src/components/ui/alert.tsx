import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/ui/cn";

const tones = {
  info: { box: "bg-info-soft text-info", Icon: Info },
  success: { box: "bg-success-soft text-success", Icon: CheckCircle2 },
  warning: { box: "bg-warning-soft text-warning", Icon: AlertTriangle },
  danger: { box: "bg-danger-soft text-danger", Icon: XCircle },
} as const;

// An inline message. role="alert" makes screen readers announce errors as soon as they appear.
export function Alert({ tone = "info", children, className }: { tone?: keyof typeof tones; children: ReactNode; className?: string }) {
  const { box, Icon } = tones[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex gap-2 rounded-md px-3 py-2 text-[13px]", box, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="text-fg">{children}</div>
    </div>
  );
}
