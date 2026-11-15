import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
}

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
  };
}

// Where files live. FILE_STORAGE_DIR can point somewhere else (for example a mounted volume in production);
// by default it is `storage/private` inside the project, which is kept out of git.
const globalForStorage = globalThis as unknown as { __hrStorage?: FileStorage };
export function getFileStorage(): FileStorage {
  globalForStorage.__hrStorage ??= createLocalStorage(process.env.FILE_STORAGE_DIR?.trim() || path.join(process.cwd(), "storage", "private"));
  return globalForStorage.__hrStorage;
}
