import type { Metadata } from "next";
// The Inter font files are bundled with the app and served from our own server (no Google request).
import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  title: "HRMS",
  description: "Human resource management.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full bg-background text-fg">{children}</body>
    </html>
  );
}
