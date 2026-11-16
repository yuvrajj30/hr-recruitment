import type { ReactNode } from "react";

// The public careers pages: no sidebar, no account, readable on a phone.
export default function CareersLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      {children}
      <footer className="mt-10 border-t border-border pt-4 text-xs text-fg-subtle">
        Your details are used only to consider your application. Each organisation&apos;s privacy notice explains how they are kept and how to have them removed.
      </footer>
    </main>
  );
}
