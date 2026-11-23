// Task evidence and resource files (src/lib/tasks/evidence.ts): the type is decided from the CONTENT, never from the
// name or the browser's claim; size and type limits match the database CHECKs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createLocalStorage, newStorageKey } from "@/lib/recruitment/storage";
import { checkEvidence, detectEvidenceKind } from "@/lib/tasks/evidence";
import { TASK_LIMITS } from "@/lib/tasks/rules";

const bytes = (...head: number[]) => new Uint8Array([...head, ...new Array(64).fill(0)]);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const WEBP = bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"));
const HEIC = bytes(0, 0, 0, 0x18, ...ascii("ftypheic"));
const HEIX = bytes(0, 0, 0, 0x18, ...ascii("ftypheix"));
const MIF1 = bytes(0, 0, 0, 0x18, ...ascii("ftypmif1"));
const PDF = bytes(...ascii("%PDF-1.7"));

describe("detectEvidenceKind", () => {
  it("recognises photos and PDFs by their first bytes", () => {
    expect(detectEvidenceKind(JPEG)).toEqual({ proof: "PHOTO", mimeType: "image/jpeg", extension: "jpg" });
    expect(detectEvidenceKind(PNG)).toEqual({ proof: "PHOTO", mimeType: "image/png", extension: "png" });
    expect(detectEvidenceKind(WEBP)).toEqual({ proof: "PHOTO", mimeType: "image/webp", extension: "webp" });
    for (const h of [HEIC, HEIX, MIF1]) expect(detectEvidenceKind(h)).toEqual({ proof: "PHOTO", mimeType: "image/heic", extension: "heic" });
    expect(detectEvidenceKind(PDF)).toEqual({ proof: "DOCUMENT", mimeType: "application/pdf", extension: "pdf" });
  });

  it("goes by content, not the name, and refuses everything else", () => {
    expect(detectEvidenceKind(PDF)).toMatchObject({ mimeType: "application/pdf" });
    expect(detectEvidenceKind(bytes(...ascii("GIF89a")))).toBeNull();
    expect(detectEvidenceKind(bytes(...ascii("<svg xmlns")))).toBeNull();
    expect(detectEvidenceKind(bytes(...ascii("<!DOCTYPE html>")))).toBeNull();
    expect(detectEvidenceKind(bytes(0x4d, 0x5a))).toBeNull();
    expect(detectEvidenceKind(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")))).toBeNull();
  });
});

describe("checkEvidence", () => {
  it("accepts a photo with a safe name whose extension matches the content", () => {
    const r = checkEvidence({ name: "../../Store photo!!.png", size: JPEG.length }, JPEG);
    expect(r).toEqual({ ok: true, kind: { proof: "PHOTO", mimeType: "image/jpeg", extension: "jpg" }, safeName: "Store photo.jpg" });
  });

  it(`refuses empty files, files over ${TASK_LIMITS.fileMaxBytes} bytes and unknown types`, () => {
    expect(checkEvidence({ name: "a.jpg", size: 0 }, new Uint8Array()).ok).toBe(false);
    expect(checkEvidence({ name: "a.jpg", size: TASK_LIMITS.fileMaxBytes + 1 }, JPEG).ok).toBe(false);
    expect(checkEvidence({ name: "a.gif", size: 70 }, bytes(...ascii("GIF89a"))).ok).toBe(false);
  });
});

describe("task files in the private store", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cafeos-tasks-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("stores and reads tasks/ keys and refuses anything that leaves the folder", async () => {
    const store = createLocalStorage(dir);
    const key = newStorageKey("tasks", new Date("2026-11-24T00:00:00Z"));
    expect(key).toMatch(/^tasks\/2026\/[0-9a-f-]{36}$/);
    await store.put(key, JPEG);
    expect(Buffer.from((await store.get(key))!).equals(Buffer.from(JPEG))).toBe(true);
    await expect(store.put("tasks/../secret", JPEG)).rejects.toThrow(/invalid storage key/);
    await expect(store.put("tasks/2026/not-a-uuid", JPEG)).rejects.toThrow(/invalid storage key/);
  });
});
