import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · HR Recruitment" };

// The page itself is plain, fixed content. The form reads "?next=" from the address in the browser,
// which needs a <Suspense> boundary under Cache Components.
export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-sm font-medium uppercase tracking-widest text-amber-800 dark:text-amber-500">The Trust Coffee</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Sign in to HR Recruitment</h1>
        </div>
        <Suspense fallback={<div className="h-64 rounded-lg border border-zinc-200 dark:border-zinc-800" aria-hidden />}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
