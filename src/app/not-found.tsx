import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found · HRMS" };

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-16">
      <div className="w-full max-w-md text-center">
        <p className="text-sm font-semibold text-accent">404</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-sm text-fg-muted">This page does not exist, or it is not available yet.</p>
        <div className="mt-6 flex justify-center">
          <Button asChild>
            <Link href="/dashboard">Go to dashboard</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
