import { describe, expect, it } from "vitest";
import { expiredBackups } from "../../scripts/backup-expiry";

const now = new Date("2026-12-20T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const file = (name: string, age: number) => ({ name, full: `/b/${name}`, mtime: daysAgo(age), dir: false });
const dir = (name: string, age: number, verified = true) => ({ name, full: `/b/${name}`, mtime: daysAgo(age), dir: true, verified });
const dump = (name: string, age: number) => [file(`${name}.dump`, age), file(`${name}.dump.sha256`, age)];
const names = (xs: { name: string }[]) => xs.map((e) => e.name).sort();

describe("backup expiry", () => {
  it("expires dumps, their side files and file backups older than the retention period", () => {
    const entries = [
      ...dump("hr-before-m2", 36), file("hr-before-m2.dump.restore-verified.json", 36),
      dir("storage-private-20261114", 36),
      ...dump("hr-recent", 10), dir("storage-private-20261210", 10),
      file("roles-rehearsal-report.json", 40), // not a backup: never touched
      file("notes.txt", 90),
    ];
    expect(names(expiredBackups(entries, now, 30))).toEqual(
      ["hr-before-m2.dump", "hr-before-m2.dump.restore-verified.json", "hr-before-m2.dump.sha256", "storage-private-20261114"].sort(),
    );
  });

  it("always keeps the newest VERIFIED dump and the newest verified file backup, however old (a complete pair)", () => {
    const entries = [...dump("old", 90), ...dump("newest", 60), dir("storage-private-old", 90), dir("storage-private-newest", 60)];
    expect(names(expiredBackups(entries, now, 30))).toEqual(["old.dump", "old.dump.sha256", "storage-private-old"]);
  });

  it("does not let a failed or unverified backup stand in for the newest one", () => {
    const entries = [
      ...dump("good", 40), // the newest verified dump: kept
      file("broken.dump", 35), // newer, but no checksum: an unverified dump is not kept
      dir("storage-private-good", 40),
      dir("storage-private-unverified", 35, false), // newer folder without its manifest checksum: not kept
    ];
    expect(names(expiredBackups(entries, now, 30))).toEqual(["broken.dump", "storage-private-unverified"]);
  });

  it("removes half-written leftovers of a failed run after a day, never the newest verified backup", () => {
    const entries = [
      ...dump("good", 3), dir("storage-private-good", 3),
      file("hr-daily-x.dump.partial", 2), dir("storage-private-x.partial", 2, false),
      file("hr-daily-y.dump.partial", 0.5), // still being written perhaps: left alone
    ];
    expect(names(expiredBackups(entries, now, 30))).toEqual(["hr-daily-x.dump.partial", "storage-private-x.partial"]);
  });

  it("expires nothing inside the retention period", () => {
    expect(expiredBackups([...dump("a", 29), dir("storage-private-x", 29)], now, 30)).toEqual([]);
  });
});
