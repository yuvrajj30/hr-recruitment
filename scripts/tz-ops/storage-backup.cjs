// Backs up storage/private (uploaded resumes) to a NEW folder in ~/hr-recruitment-backups, with a SHA-256
// manifest, then verifies the copy against the originals. The originals are only read: never moved,
// changed or deleted. Stops if the target folder already exists.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const SRC = path.resolve("storage", "private");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
const DEST = path.join(process.env.HR_BACKUP_DIR || path.join(os.homedir(), "hr-recruitment-backups"), `storage-private-${stamp}`);
const stop = (m) => { console.error("STOPPED: " + m); process.exit(2); };
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) stop("symbolic link found, not copying: " + full);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

if (!fs.existsSync(SRC)) stop("storage/private does not exist");
if (fs.existsSync(DEST)) stop("backup folder already exists: " + DEST);

const files = walk(SRC).sort();
const manifest = files.map((rel) => {
  const f = path.join(SRC, rel);
  return { path: rel, bytes: fs.statSync(f).size, sha256: sha(f) };
});

// Copy (read originals, write new files). COPYFILE_EXCL: never overwrite.
fs.mkdirSync(DEST, { recursive: true });
for (const m of manifest) {
  const to = path.join(DEST, "private", m.path);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(SRC, m.path), to, fs.constants.COPYFILE_EXCL);
}
fs.writeFileSync(path.join(DEST, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), source: SRC, files: manifest }, null, 2));
fs.writeFileSync(path.join(DEST, "manifest.json.sha256"), sha(path.join(DEST, "manifest.json")) + "  manifest.json\n");

// Verify: every original is in the copy with the same size and checksum, nothing extra, originals untouched.
let bad = 0;
const copied = walk(path.join(DEST, "private")).sort();
if (JSON.stringify(copied) !== JSON.stringify(files)) { bad++; console.log("FAIL file lists differ"); }
for (const m of manifest) {
  const c = path.join(DEST, "private", m.path);
  const o = path.join(SRC, m.path);
  const okCopy = fs.statSync(c).size === m.bytes && sha(c) === m.sha256;
  const okOrig = fs.existsSync(o) && sha(o) === m.sha256;
  if (!okCopy || !okOrig) bad++;
  console.log(`${okCopy && okOrig ? "PASS" : "FAIL"}  ${m.path}  ${m.bytes} bytes  sha256 ${m.sha256.slice(0, 16)}...  copy=${okCopy} original-intact=${okOrig}`);
}
console.log(`\nbackup folder: ${DEST}`);
console.log(`files: ${manifest.length}, bytes: ${manifest.reduce((a, m) => a + m.bytes, 0)}`);
console.log(bad === 0 ? "VERIFIED: copy matches the originals; originals untouched" : `VERIFICATION FAILED (${bad})`);
process.exit(bad === 0 ? 0 : 1);
