import { redirect } from "next/navigation";

// The home page has nothing of its own: signed-in people land on the dashboard,
// and people who are not signed in are sent to /login by src/proxy.ts before they get here.
export default function Home() {
  redirect("/dashboard");
}
