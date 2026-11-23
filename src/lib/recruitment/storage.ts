import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Private file storage for candidate documents.
//
// Files are written to a folder that the web server never serves: it is outside `public/`, and the
// only way to read a file is the signed-in, permission-checked download route. The name on disk is a
// random id chosen by the server; nothing a candidate typed ever becomes part of a path.
//
// The small interface is deliberate: a cloud bucket can replace the local folder later without
// touching the code that uses it.

export interface FileStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
  // Proves this storage is the app's real file store before anything is deleted or confirmed as deleted (the
  // retention job): a wrong folder would make every deletion "succeed" on files that are not there. Returns the
  // resolved location for the job's log. Optional: in-memory stores used by tests need no check.
  verifyRoot?(): Promise<string>;
}

// Written into the storage folder with the first upload; the retention job refuses to delete files in a folder
// that has neither this marker nor a resumes/ folder.
export const STORAGE_MARKER = ".cafeos-storage";

// "resumes/2026/0193c1e2-....": a folder per year, then a random id. No extension, no original name.
export function newStorageKey(folder: "resumes" | "documents", now: Date): string {
  return `${folder}/${now.getUTCFullYear()}/${randomUUID()}`;
}

const KEY_PATTERN = /^(resumes|documents)\/\d{4}\/[0-9a-f-]{36}$/;

export function createLocalStorage(rootDir: string): FileStorage {
  const root = path.resolve(rootDir);
  const resolve = (key: string): string => {
    if (!KEY_PATTERN.test(key)) throw new Error("invalid storage key");
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error("invalid storage key");
    return full;
  };
  return {
    async put(key, bytes) {
      const full = resolve(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, bytes, { flag: "wx", mode: 0o600 }); // never overwrites an existing file
      await writeFile(path.join(root, STORAGE_MARKER), "CafeOS private file storage\n", { flag: "wx" }).catch((e: { code?: string }) => {
        if (e.code !== "EEXIST") throw e;
      });
    },
    async get(key) {
      try {
        return await readFile(resolve(key));
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      }
    },
    async remove(key) {
      await rm(resolve(key), { force: true });
    },
    async verifyRoot() {
      const isThere = async (p: string, dir: boolean) => stat(p).then((st) => (dir ? st.isDirectory() : st.isFile()), () => false);
      if (!(await isThere(root, true))) throw new Error(`storage folder not found: ${root}`);
      if (!(await isThere(path.join(root, STORAGE_MARKER), false)) && !(await isThere(path.join(root, "resumes"), true))) {
        throw new Error(`not the app's file storage (no ${STORAGE_MARKER} or resumes/ folder): ${root}`);
      }
      return root;
    },
  };
}

// Where files live. FILE_STORAGE_DIR can point somewhere else (for example a mounted volume in production);
// by default it is `storage/private` inside the project, which is kept out of git.
const globalForStorage = globalThis as unknown as { __hrStorage?: FileStorage };
export function getFileStorage(): FileStorage {
  globalForStorage.__hrStorage ??= createLocalStorage(process.env.FILE_STORAGE_DIR?.trim() || path.join(process.cwd(), "storage", "private"));
  return globalForStorage.__hrStorage;
}
