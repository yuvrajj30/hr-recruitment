// Rules for an uploaded resume. Pure functions: they look at the file's name, size and first bytes.
// The type is decided from the CONTENT of the file, never from the name or the type the browser claims.

export const RESUME_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const RESUME_ACCEPT = ".pdf,.doc,.docx";

export type ResumeKind = { extension: "pdf" | "doc" | "docx"; mimeType: string };

const startsWith = (bytes: Uint8Array, signature: number[]) => signature.every((b, i) => bytes[i] === b);

export function detectResumeKind(bytes: Uint8Array, fileName: string): ResumeKind | null {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    // "%PDF-"
    return ext === "pdf" ? { extension: "pdf", mimeType: "application/pdf" } : null;
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // A zip container. Word's .docx is one; the name must agree and it must contain a Word part.
    if (ext !== "docx" || !containsAscii(bytes, "word/")) return null;
    return { extension: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // The old Office container (.doc)
    return ext === "doc" ? { extension: "doc", mimeType: "application/msword" } : null;
  }
  return null;
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  const needle = [...text].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export type ResumeCheck = { ok: true; kind: ResumeKind; safeName: string } | { ok: false; message: string };

export function checkResume(file: { name: string; size: number }, bytes: Uint8Array): ResumeCheck {
  if (file.size === 0 || bytes.length === 0) return { ok: false, message: "The file is empty. Choose your resume again." };
  if (file.size > RESUME_MAX_BYTES || bytes.length > RESUME_MAX_BYTES) return { ok: false, message: "The resume must be 5 MB or smaller." };
  const kind = detectResumeKind(bytes, file.name);
  if (!kind) return { ok: false, message: "Upload the resume as a PDF or Word document (.pdf, .doc, .docx)." };
  return { ok: true, kind, safeName: safeFileName(file.name, kind.extension) };
}

// The name shown to HR and used when downloading. Folders, control characters and odd symbols are removed,
// and the extension is the one matching the real content.
export function safeFileName(name: string, extension: string): string {
  const base = name
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]*$/, "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ._()-]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, 80);
  return `${base || "resume"}.${extension}`;
}
