// Backs up the app's private file store (uploaded resumes and documents) to a NEW folder in the backup folder:
//   <backups>/storage-private-<stamp>/private/...   plus manifest.json (path, size, SHA-256 of every file) + .sha256
// then checks every copy. The originals are only read: never moved, changed or deleted.
//   node scripts/ops/storage-backup.cjs
// - The folder is resolved exactly as the app does: FILE_STORAGE_DIR from the environment or the app's .env files
//   (Next.js loader: .env.production.local, .env.local, .env.production, .env), otherwise storage/private. It must
//   look like the app's store (marker file or resumes/), so a wrong setting fails loudly.
// - The copy is built under a temporary name (storage-private-<stamp>.partial) and gets its final name only after
//   it is complete and verified; on any failure the partial folder is removed.
// - A file deleted while the backup runs (the retention job removing a candidate) is left out and counted, not
//   treated as an error: it is gone legitimately.
// - It refuses to start without room for two copies of the store.
// Prints only counts and the backup folder name.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const req = (m) => require(require.resolve(m, { paths: [process.cwd()] }));
let partial = null;
const stop = (m, code = 2) => {
  if (partial) fs.rmSync(partial, { recursive: true, force: true });
  console.error("STOPPED: " + m);
  process.exit(code);
};

req("@next/env").loadEnvConfig(process.cwd(), false, { info: () => {}, error: (...a) => console.error(...a) });
const SRC = path.resolve(process.env.FILE_STORAGE_DIR?.trim() || path.join(process.cwd(), "storage", "private"));
const MARKER = ".cafeos-storage"; // STORAGE_MARKER in src/lib/recruitment/storage.ts
const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();
if (!isDir(SRC)) stop(`file store not found: ${SRC}`);
if (!fs.existsSync(path.join(SRC, MARKER)) && !isDir(path.join(SRC, "resumes"))) stop(`not the app's file store (no ${MARKER} or resumes/): ${SRC}`);

const BACKUPS = process.env.HR_BACKUP_DIR || path.join(os.homedir(), "hr-recruitment-backups");
fs.mkdirSync(BACKUPS, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
const DEST = path.join(BACKUPS, `storage-private-${stamp}`);
if (fs.existsSync(DEST) || fs.existsSync(DEST + ".partial")) stop("backup folder already exists: " + DEST);

const gone = (e) => Boolean(e && e.code === "ENOENT");
function walk(dir, base = dir) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (gone(e)) return []; throw e; }
  return list.flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) stop("symbolic link found, not copying: " + full);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

try {
  const listed = walk(SRC).sort();
  const sizes = listed.map((rel) => { try { return fs.statSync(path.join(SRC, rel)).size; } catch (e) { if (gone(e)) return 0; throw e; } });
  const need = 2 * sizes.reduce((a, b) => a + b, 0) + 50 * 1024 * 1024; // two copies plus room for the day's dump
  const st = fs.statfsSync(BACKUPS);
  if (st.bavail * st.bsize < need) stop(`not enough free space in ${BACKUPS} (need about ${Math.ceil(need / 1048576)} MB)`);

  partial = DEST + ".partial";
  fs.mkdirSync(path.join(partial, "private"), { recursive: true });
  const manifest = [];
  let removedMeanwhile = 0;
  for (const rel of listed) {
    const from = path.join(SRC, rel);
    const to = path.join(partial, "private", rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      if (gone(e)) { removedMeanwhile++; continue; } // deleted by the retention job while we ran
      throw e;
    }
    manifest.push({ path: rel, bytes: fs.statSync(to).size, sha256: sha(to) });
  }
  // Same manifest format as scripts/tz-ops/storage-backup.cjs, so scripts/tz-ops/tz-restore-verify.cjs can check it.
  const mf = path.join(partial, "manifest.json");
  fs.writeFileSync(mf, JSON.stringify({ createdAt: new Date().toISOString(), source: SRC, files: manifest }, null, 2));
  fs.writeFileSync(mf + ".sha256", sha(mf) + "  manifest.json\n");

  // Verify: every recorded copy matches; an original that still exists matches its copy (it may have been removed
  // by the retention job meanwhile, which is not an error).
  let bad = 0;
  const copied = walk(path.join(partial, "private")).sort();
  if (JSON.stringify(copied) !== JSON.stringify(manifest.map((m) => m.path).sort())) { bad++; console.log("FAIL  the copied file list differs from the manifest"); }
  for (const m of manifest) {
    const c = path.join(partial, "private", m.path);
    const o = path.join(SRC, m.path);
    const okCopy = fs.existsSync(c) && fs.statSync(c).size === m.bytes && sha(c) === m.sha256;
    let okOrig = true;
    try { okOrig = sha(o) === m.sha256; } catch (e) { if (!gone(e)) throw e; removedMeanwhile++; }
    if (!okCopy || !okOrig) { bad++; console.log(`FAIL  a copy does not match its original (copy=${okCopy} original=${okOrig})`); }
  }
  if (bad) stop(`verification failed (${bad})`, 1);
  fs.renameSync(partial, DEST);
  partial = null;
  console.log(`files backup: ${DEST} (${manifest.length} files, ${manifest.reduce((a, m) => a + m.bytes, 0)} bytes${removedMeanwhile ? `; ${removedMeanwhile} removed by the retention job while copying` : ""})`);
  console.log("VERIFIED: every copy matches its original; originals untouched");
} catch (e) {
  stop(`backup failed (${e && e.code ? e.code : e && e.name ? e.name : "error"})`, 1);
}
