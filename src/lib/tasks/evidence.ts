// Task evidence and resource files: pure checks. The type is decided from the CONTENT of the file, never from its name
// or the type the browser claims; the database CHECKs repeat the type and size limits.
import { safeFileName } from "@/lib/recruitment/resume";
import { TASK_LIMITS } from "./rules";

export type EvidenceKind = { proof: "PHOTO" | "DOCUMENT"; mimeType: string; extension: string };

const startsWith = (bytes: Uint8Array, signature: number[], at = 0) => signature.every((b, i) => bytes[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

// The file name is not used to decide the type (a .jpg that is really a PDF is a PDF).
export function detectEvidenceKind(bytes: Uint8Array): EvidenceKind | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { proof: "PHOTO", mimeType: "image/jpeg", extension: "jpg" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { proof: "PHOTO", mimeType: "image/png", extension: "png" };
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return { proof: "PHOTO", mimeType: "image/webp", extension: "webp" };
  // HEIC/HEIF from phones: an ISO box "ftyp" at offset 4 with a HEIF brand.
  if (startsWith(bytes, ascii("ftyp"), 4) && ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].some((b) => startsWith(bytes, ascii(b), 8))) {
    return { proof: "PHOTO", mimeType: "image/heic", extension: "heic" };
  }
  if (startsWith(bytes, ascii("%PDF-"))) return { proof: "DOCUMENT", mimeType: "application/pdf", extension: "pdf" };
  return null;
}

export type EvidenceCheck = { ok: true; kind: EvidenceKind; safeName: string } | { ok: false; message: string };

export function checkEvidence(file: { name: string; size: number }, bytes: Uint8Array): EvidenceCheck {
  if (file.size === 0 || bytes.length === 0) return { ok: false, message: `"${display(file.name)}" is empty. Choose the file again.` };
  if (file.size > TASK_LIMITS.fileMaxBytes || bytes.length > TASK_LIMITS.fileMaxBytes) return { ok: false, message: `"${display(file.name)}" is larger than 5 MB.` };
  const kind = detectEvidenceKind(bytes);
  if (!kind) return { ok: false, message: `"${display(file.name)}" is not a photo (JPEG, PNG, WebP, HEIC) or a PDF.` };
  return { ok: true, kind, safeName: safeFileName(file.name, kind.extension).replace(/^resume\./, "file.") };
}

const display = (name: string) => name.replace(/^.*[\\/]/, "").slice(0, 60);
