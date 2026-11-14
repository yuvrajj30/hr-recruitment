import { cn } from "@/lib/ui/cn";

// A grey placeholder shown while real content loads. Never used to stand in for missing data.
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-surface-muted", className)} />;
}
