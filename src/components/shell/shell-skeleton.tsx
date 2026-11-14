import { Skeleton } from "@/components/ui/skeleton";

// Shown for the moment it takes to check the session. Same frame as the real shell, so nothing jumps.
export function ShellSkeleton() {
  return (
    <div className="flex min-h-dvh" aria-busy="true" aria-label="Loading">
      <div className="hidden w-16 shrink-0 border-r border-border bg-surface md:block lg:w-60">
        <div className="space-y-3 p-3">
          <Skeleton className="h-9" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      </div>
      <div className="flex-1">
        <div className="h-14 border-b border-border bg-surface" />
        <div className="mx-auto max-w-6xl space-y-4 px-4 py-8 sm:px-6">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
          <div className="grid gap-4 pt-2 sm:grid-cols-2">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        </div>
      </div>
    </div>
  );
}
