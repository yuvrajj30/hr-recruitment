import { describe, expect, it } from "vitest";
import { decideGate } from "@/lib/auth/proxy-gate";

const gate = (pathname: string, hasSessionCookie: boolean, search = "") => decideGate({ pathname, search, hasSessionCookie });

describe("proxy gate", () => {
  it("lets the login page through, signed in or not", () => {
    expect(gate("/login", false)).toEqual({ kind: "allow" });
    expect(gate("/login", true)).toEqual({ kind: "allow" });
    expect(gate("/login/", false)).toEqual({ kind: "allow" });
  });
  it("lets anyone with a session cookie through (the page itself checks the real session)", () => {
    expect(gate("/dashboard", true)).toEqual({ kind: "allow" });
    expect(gate("/", true)).toEqual({ kind: "allow" });
  });
  it("sends people without a cookie to the login page and remembers where they were going", () => {
    expect(gate("/dashboard", false)).toEqual({ kind: "redirect", location: "/login?next=%2Fdashboard" });
    expect(gate("/jobs", false, "?status=open&page=2")).toEqual({
      kind: "redirect",
      location: "/login?next=%2Fjobs%3Fstatus%3Dopen%26page%3D2",
    });
    expect(gate("/dashboard/", false)).toEqual({ kind: "redirect", location: "/login?next=%2Fdashboard" });
  });
  it("does not remember the home page", () => {
    expect(gate("/", false)).toEqual({ kind: "redirect", location: "/login" });
  });
  it("never puts something unsafe into 'next'", () => {
    for (const path of ["//evil.com", "/\\evil.com", "/api/auth/logout", "/a b"]) {
      expect(gate(path, false)).toEqual({ kind: "redirect", location: "/login" });
    }
    const huge = gate("/x", false, "?q=" + "a".repeat(600));
    expect(huge).toEqual({ kind: "redirect", location: "/login" });
  });
});
