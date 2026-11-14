"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

// Shown inside the sidebar and header when one page fails, so the person can still move around.
// The error text is never shown: it could contain internal details.
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card>
      <EmptyState
        icon={AlertTriangle}
        title="This page could not be shown"
        description="Something went wrong on our side. Nothing you entered was lost or shared. Please try again."
        action={<Button onClick={() => reset()}>Try again</Button>}
      />
    </Card>
  );
}
