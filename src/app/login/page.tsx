import type { Metadata } from "next";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · HRMS" };

// The page itself is fixed content. The form reads "?next=" from the address in the browser,
// which needs a <Suspense> boundary under Cache Components.
export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <span aria-hidden className="flex size-10 items-center justify-center rounded-[10px] bg-accent text-base font-bold text-on-accent">
            H
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Sign in to HRMS</h1>
          <p className="mt-1 text-sm text-fg-muted">Use the email and password for your work account.</p>
        </div>
        <Suspense fallback={<Skeleton className="h-[290px] rounded-[10px]" />}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
