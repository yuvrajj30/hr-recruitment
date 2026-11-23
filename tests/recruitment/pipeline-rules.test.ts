import { describe, expect, it } from "vitest";
import { applyRateKeys, checkFormToken, createRateLimiter, issueFormToken } from "@/lib/recruitment/abuse";
import {
  formDataToApplicationFields,
  looksLikeReference,
  makeReferenceNumber,
  normalizePhone,
  parseApplicationInput,
  phoneMatchKey,
  readSnapshot,
  toSnapshot,
} from "@/lib/recruitment/application-input";
import { checkResume, detectResumeKind, RESUME_MAX_BYTES, safeFileName } from "@/lib/recruitment/resume";
import { allowedMoves, checkMove, moveKind } from "@/lib/recruitment/stages";

const valid = { fullName: "Asha Verma", email: " Asha.Verma@Example.com ", phone: "98765 43210" };
const bytes = (...b: number[]) => new Uint8Array(b);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...[..."xxxxword/document.xml"].map((c) => c.charCodeAt(0))]);

describe("stage rules", () => {
  it("allows forward moves, including skipping stages", () => {
    expect(moveKind("APPLIED", "UNDER_REVIEW")).toBe("forward");
    expect(moveKind("APPLIED", "SELECTED")).toBe("forward");
    expect(checkMove("UNDER_REVIEW", "SHORTLISTED", "")).toMatchObject({ ok: true, reason: null });
  });
  it("needs a reason to move backwards, reject or reopen", () => {
    expect(checkMove("SHORTLISTED", "APPLIED", " ").ok).toBe(false);
    expect(checkMove("SHORTLISTED", "APPLIED", "moved by mistake")).toMatchObject({ ok: true, kind: "backward" });
    expect(checkMove("APPLIED", "REJECTED", null).ok).toBe(false);
    expect(checkMove("APPLIED", "REJECTED", "  Not enough experience ")).toMatchObject({ ok: true, kind: "reject", reason: "Not enough experience" });
    expect(checkMove("REJECTED", "UNDER_REVIEW", undefined).ok).toBe(false);
    expect(checkMove("REJECTED", "UNDER_REVIEW", "candidate sent more details")).toMatchObject({ ok: true, kind: "restore" });
  });
  it("lets a candidate withdraw without a reason", () => {
    expect(checkMove("INTERVIEW_SCHEDULED", "WITHDRAWN", null)).toMatchObject({ ok: true, kind: "withdraw" });
  });
  it("refuses moves that make no sense", () => {
    expect(moveKind("APPLIED", "APPLIED")).toBeNull();
    expect(moveKind("REJECTED", "WITHDRAWN")).toBeNull();
    expect(moveKind("WITHDRAWN", "SELECTED")).toBeNull();
    expect(moveKind("SELECTED", "OFFER_ISSUED")).toBeNull(); // later milestone
    expect(moveKind("OFFER_ISSUED", "REJECTED")).toBeNull();
    expect(checkMove("APPLIED", "REJECTED", "x".repeat(1001)).ok).toBe(false);
  });
  it("lists the next stages in pipeline order", () => {
    expect(allowedMoves("INTERVIEW_COMPLETED").map((m) => m.to)).toEqual([
      "APPLIED", "UNDER_REVIEW", "SHORTLISTED", "INTERVIEW_SCHEDULED", "SELECTED", "REJECTED", "WITHDRAWN",
    ]);
    expect(allowedMoves("JOINED")).toEqual([]);
  });
});

describe("application form input", () => {
  it("accepts the minimum and normalises email and phone", () => {
    const r = parseApplicationInput(valid);
    expect(r.ok && r.value).toMatchObject({ fullName: "Asha Verma", email: "asha.verma@example.com", phone: "+919876543210", city: null, skills: [], graduationYear: null });
  });
  it("reports missing and malformed fields", () => {
    const r = parseApplicationInput({ fullName: "1", email: "not-an-email", phone: "abc" });
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(["email", "fullName", "phone"]);
    expect(parseApplicationInput({ ...valid, graduationYear: "25" }).ok).toBe(false);
    expect(parseApplicationInput({ ...valid, graduationYear: "1900" }).ok).toBe(false);
  });
  it("needs an institution with education details, and a company with a role", () => {
    const edu = parseApplicationInput({ ...valid, degree: "B.Com" });
    expect(!edu.ok && edu.errors).toHaveProperty("institution");
    const exp = parseApplicationInput({ ...valid, experienceCompany: "Cafe Uno" });
    expect(!exp.ok && exp.errors).toHaveProperty("experienceTitle");
  });
  it("only accepts ordinary web links", () => {
    const ok = parseApplicationInput({ ...valid, linkedinUrl: "linkedin.com/in/asha", portfolioUrl: "http://github.com/asha" });
    expect(ok.ok && ok.value).toMatchObject({ linkedinUrl: "https://linkedin.com/in/asha", portfolioUrl: "https://github.com/asha" });
    for (const bad of ["javascript:alert(1)", "https://user:pw@evil.example", "https://localhost/x", "data:text/html,x"]) {
      expect(parseApplicationInput({ ...valid, portfolioUrl: bad }).ok, bad).toBe(false);
    }
    expect(parseApplicationInput({ ...valid, linkedinUrl: "https://evil.example/linkedin.com" }).ok).toBe(false);
  });
  it("reads known fields only from a form", () => {
    const fd = new FormData();
    fd.set("fullName", "A");
    fd.set("organizationId", "x");
    fd.set("stage", "SELECTED");
    fd.append("email", "a@b.c");
    fd.append("email", "d@e.f");
    const fields = formDataToApplicationFields(fd);
    expect(fields).not.toHaveProperty("organizationId");
    expect(fields).not.toHaveProperty("stage");
    expect(fields.email).toBeUndefined();
  });
  it("normalises phone numbers", () => {
    expect(normalizePhone("+91 98765-43210")).toBe("+919876543210");
    expect(normalizePhone("098765 43210")).toBe("+919876543210");
    expect(normalizePhone("919876543210")).toBe("+919876543210");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("call me")).toBeNull();
    expect(phoneMatchKey("+919876543210")).toBe("9876543210");
  });
  it("keeps an exact, defensive copy of what was submitted", () => {
    const r = parseApplicationInput({ ...valid, institution: "DAVV", degree: "BBA", graduationYear: "2025", skills: "Espresso, espresso, Billing", experienceDescription: "Helped at a family cafe" });
    if (!r.ok) throw new Error("expected ok");
    const snap = toSnapshot(r.value);
    expect(snap).toMatchObject({ education: { institution: "DAVV", degree: "BBA", graduationYear: 2025 }, skills: ["Espresso", "Billing"], experience: null, experienceNote: "Helped at a family cafe" });
    expect(readSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
    expect(readSnapshot({ version: 1, fullName: "X", email: "x@y.z", portfolioUrl: "javascript:alert(1)", skills: "nope" })).toMatchObject({ portfolioUrl: null, skills: [] });
    expect(readSnapshot(null)).toBeNull();
    expect(readSnapshot({ version: 2 })).toBeNull();
  });
  it("makes readable reference numbers", () => {
    const ref = makeReferenceNumber(2026, new Uint8Array([0, 1, 2, 30, 31, 255]));
    expect(ref).toMatch(/^APP-2026-[2-9A-HJKMNP-Z]{6}$/);
    expect(looksLikeReference(ref)).toBe(true);
    expect(looksLikeReference("asha")).toBe(false);
  });
});

describe("resume checks", () => {
  it("decides the type from the content, and the name must agree", () => {
    expect(detectResumeKind(PDF, "cv.pdf")?.extension).toBe("pdf");
    expect(detectResumeKind(DOCX, "cv.docx")?.extension).toBe("docx");
    expect(detectResumeKind(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), "cv.doc")?.extension).toBe("doc");
    expect(detectResumeKind(PDF, "cv.docx")).toBeNull();
    expect(detectResumeKind(bytes(0x4d, 0x5a, 0x90, 0x00), "cv.pdf")).toBeNull(); // a program renamed to .pdf
    expect(detectResumeKind(bytes(0x50, 0x4b, 0x03, 0x04, 1, 2, 3), "cv.docx")).toBeNull(); // a zip that is not a Word file
    expect(detectResumeKind(new TextEncoder().encode("<html><script>"), "cv.pdf")).toBeNull();
  });
  it("rejects empty and oversized files", () => {
    expect(checkResume({ name: "cv.pdf", size: 0 }, new Uint8Array()).ok).toBe(false);
    expect(checkResume({ name: "cv.pdf", size: RESUME_MAX_BYTES + 1 }, PDF).ok).toBe(false);
    expect(checkResume({ name: "cv.pdf", size: PDF.length }, PDF)).toMatchObject({ ok: true, safeName: "cv.pdf" });
  });
  it("cleans file names", () => {
    expect(safeFileName("..\\..\\windows\\system32\\evil<script>.pdf", "pdf")).toBe("evilscript.pdf");
    expect(safeFileName("/etc/passwd", "pdf")).toBe("passwd.pdf");
    expect(safeFileName("Asha Verma — CV (2026).PDF", "pdf")).toBe("Asha Verma CV (2026).pdf");
    expect(safeFileName("....", "docx")).toBe("resume.docx");
  });
});

describe("public form protection", () => {
  const secret = "s".repeat(32);
  const t0 = new Date("2026-11-15T10:00:00Z");
  const later = (s: number) => new Date(t0.getTime() + s * 1000);
  it("accepts a form that was open for a sensible time", () => {
    const token = issueFormToken(secret, "job-1", t0);
    expect(checkFormToken(secret, "job-1", token, later(1))).toBe("too_fast");
    expect(checkFormToken(secret, "job-1", token, later(30))).toBe("ok");
    expect(checkFormToken(secret, "job-1", token, later(25 * 3600))).toBe("expired");
  });
  it("rejects forged, reused-elsewhere and missing tokens", () => {
    const token = issueFormToken(secret, "job-1", t0);
    expect(checkFormToken(secret, "job-2", token, later(30))).toBe("invalid");
    expect(checkFormToken("x".repeat(32), "job-1", token, later(30))).toBe("invalid");
    expect(checkFormToken(secret, "job-1", token.replace(/^\d+/, "1000000000"), later(30))).toBe("invalid");
    expect(checkFormToken(secret, "job-1", undefined, later(30))).toBe("invalid");
  });
  it("limits how often one key may submit, and forgets old events", () => {
    const limiter = createRateLimiter(2, 60_000);
    expect([limiter.hit("a", t0), limiter.hit("a", later(1)), limiter.hit("a", later(2))]).toEqual([true, true, false]);
    expect(limiter.hit("b", later(2))).toBe(true);
    expect(limiter.hit("a", later(61))).toBe(true);
  });
  it("counts public applications only by keyed hashes, never the address or email itself", () => {
    const k = applyRateKeys(secret, { ipAddress: "203.0.113.5", email: "A@X.test" });
    expect(k.addressHash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(k)).not.toMatch(/203.0.113|x.test/i);
    expect(applyRateKeys(secret, { ipAddress: "203.0.113.5", email: "a@x.test" }).emailHash).toBe(k.emailHash); // case-insensitive
    expect(applyRateKeys("y".repeat(32), { ipAddress: "203.0.113.5", email: "a@x.test" }).emailHash).not.toBe(k.emailHash); // keyed
    expect(applyRateKeys(secret, { ipAddress: null, email: "a@x.test" }).addressHash).toBeNull();
    // An address and an email never share a key.
    expect(applyRateKeys(secret, { ipAddress: "a@x.test", email: "a@x.test" }).addressHash).not.toBe(k.emailHash);
  });
  it("does not grow without limit", () => {
    const limiter = createRateLimiter(1, 60_000, 3);
    for (const k of ["a", "b", "c", "d", "e"]) limiter.hit(k, t0);
    expect(limiter.size()).toBe(3);
  });
});
