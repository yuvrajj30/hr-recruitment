"use client";

import { Button } from "@/components/ui/button";

// Shown if something unexpected breaks outside the signed-in area.
// It deliberately never shows the error text (it could contain internal details).
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-2 text-sm text-fg-muted">The page could not be shown. Nothing you entered was lost or shared. Please try again.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => reset()}>Try again</Button>
          <Button variant="secondary" asChild>
            <a href="/dashboard">Go to dashboard</a>
          </Button>
        </div>
      </div>
    </main>
  );
}
