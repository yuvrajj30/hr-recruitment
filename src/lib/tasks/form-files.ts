// Files from a task form, before the service sees them. An unused file box arrives as an EMPTY entry (in the browser an
// empty File with no name; on the server sometimes a nameless Blob): any empty entry, and any text value, is skipped.
// The count and size are checked before a file is read into memory; the service then checks each file's content.
import { TASK_LIMITS } from "./rules";

export type Upload = { name: string; size: number; bytes: Uint8Array };
export type UploadsRead = { ok: true; files: Upload[] } | { ok: false; message: string };

export async function readUploads(entries: FormDataEntryValue[] | (string | Blob)[]): Promise<UploadsRead> {
  const blobs: Blob[] = [];
  for (const v of entries) if (typeof v !== "string" && v.size > 0) blobs.push(v);
  if (blobs.length > TASK_LIMITS.filesMax) return { ok: false, message: `Attach at most ${TASK_LIMITS.filesMax} files.` };
  const nameOf = (b: Blob) => ("name" in b && typeof b.name === "string" && b.name ? b.name : "file");
  const big = blobs.find((b) => b.size > TASK_LIMITS.fileMaxBytes);
  if (big) return { ok: false, message: `"${nameOf(big).slice(0, 60)}" is larger than 5 MB.` };
  if (blobs.reduce((sum, b) => sum + b.size, 0) > TASK_LIMITS.uploadTotalMaxBytes) {
    return { ok: false, message: "Attach at most 5 MB in total. Use fewer or smaller photos." };
  }
  const files = await Promise.all(blobs.map(async (b) => ({ name: nameOf(b), size: b.size, bytes: new Uint8Array(await b.arrayBuffer()) })));
  return { ok: true, files };
}
