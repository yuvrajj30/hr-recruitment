import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { SignOutButtons } from "./sign-out-buttons";

export const metadata: Metadata = { title: "Dashboard · HR Recruitment" };

// Checking who is signed in needs the request's cookies, so it happens inside <Suspense>.
export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-3xl px-4 py-12" aria-busy="true">
          <p className="text-zinc-600 dark:text-zinc-400">Loading…</p>
        </main>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}

async function DashboardContent() {
  const auth = await getCurrentAuth();
  // Cookie missing, expired, signed out elsewhere, account or organization disabled: all end up here.
  if (!auth) redirect("/login?next=%2Fdashboard&reason=expired");

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-widest text-amber-800 dark:text-amber-500">The Trust Coffee</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Welcome, {auth.user.name}</h1>
        </div>
        <SignOutButtons />
      </header>

      <dl className="mt-8 grid gap-4 rounded-lg border border-zinc-200 bg-white p-6 text-sm shadow-sm sm:grid-cols-2 dark:border-zinc-800 dark:bg-zinc-950">
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">Signed in as</dt>
          <dd className="mt-0.5 font-medium">{auth.user.email}</dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">Organization</dt>
          <dd className="mt-0.5 font-medium">{auth.organization ? auth.organization.name : "None selected"}</dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">Your roles</dt>
          <dd className="mt-0.5 font-medium">{auth.roleKeys.length > 0 ? auth.roleKeys.join(", ") : "No roles assigned"}</dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">Permissions</dt>
          <dd className="mt-0.5 font-medium">{auth.permissions.size}</dd>
        </div>
      </dl>

      <p className="mt-8 text-sm text-zinc-600 dark:text-zinc-400">
        Sign-in is working. Jobs, candidates and interviews arrive in the next milestones.
      </p>
    </main>
  );
}
