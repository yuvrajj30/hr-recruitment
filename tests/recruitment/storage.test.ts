import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalStorage, STORAGE_MARKER, newStorageKey } from "@/lib/recruitment/storage";

describe("private file storage", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "hr-storage-test-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores, reads and removes a file under a random server-chosen name", async () => {
    const storage = createLocalStorage(root);
    const key = newStorageKey("resumes", new Date("2026-11-15T00:00:00Z"));
    expect(key).toMatch(/^resumes\/2026\/[0-9a-f-]{36}$/);
    const bytes = new Uint8Array([1, 2, 3]);
    await storage.put(key, bytes);
    expect(new Uint8Array((await storage.get(key))!)).toEqual(bytes);
    await expect(storage.put(key, bytes)).rejects.toThrow(); // never overwrites
    await storage.remove(key);
    expect(await storage.get(key)).toBeNull();
    await storage.remove(key); // removing twice is harmless
  });

  it("refuses any key that is not one it issued, so nothing can escape the folder", async () => {
    const storage = createLocalStorage(root);
    for (const key of ["../outside", "resumes/2026/../../../etc/passwd", "/etc/passwd", "C:\\Windows\\win.ini", "resumes/2026/cv.pdf", "resumes/2026/00000000-0000-0000-0000-000000000000/x", ""]) {
      await expect(storage.put(key, new Uint8Array([1])), key).rejects.toThrow("invalid storage key");
      await expect(storage.get(key), key).rejects.toThrow("invalid storage key");
    }
    // Only the store's own marker (written with a valid upload) and the resumes folder.
    expect((await readdir(root)).filter((n) => n !== "resumes" && n !== STORAGE_MARKER)).toEqual([]);
  });
});
