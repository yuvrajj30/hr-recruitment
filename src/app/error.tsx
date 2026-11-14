"use client";

// Shown if something unexpected breaks while a page is being built.
// It deliberately never shows the error text (it could contain internal details).
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-3 text-zinc-600 dark:text-zinc-400">
          The page could not be shown. Nothing you entered was lost or shared. Please try again.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-md bg-amber-800 px-4 py-2 text-sm font-medium text-white hover:bg-amber-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2"
          >
            Try again
          </button>
          <a
            href="/dashboard"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Go to dashboard
          </a>
        </div>
      </div>
    </main>
  );
}
