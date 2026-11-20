import { describe, expect, it } from "vitest";
import { expiredBackups } from "../../scripts/backup-expiry";

const now = new Date("2026-12-20T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const file = (name: string, age: number) => ({ name, full: `/b/${name}`, mtime: daysAgo(age), dir: false });
const dir = (name: string, age: number) => ({ name, full: `/b/${name}`, mtime: daysAgo(age), dir: true });

describe("backup expiry", () => {
  it("expires dumps, their side files and private-file copies older than the retention period", () => {
    const entries = [
      file("hr-before-m2.dump", 36), file("hr-before-m2.dump.sha256", 36), file("hr-before-m2.dump.restore-verified.json", 36),
      dir("storage-private-20261114", 36),
      file("hr-recent.dump", 10), file("hr-recent.dump.sha256", 10), dir("storage-private-20261210", 10),
      file("roles-rehearsal-report.json", 40), // not a backup: never touched
      file("notes.txt", 90),
    ];
    expect(expiredBackups(entries, now, 30).map((e) => e.name).sort()).toEqual(
      ["hr-before-m2.dump", "hr-before-m2.dump.restore-verified.json", "hr-before-m2.dump.sha256", "storage-private-20261114"].sort(),
    );
  });

  it("always keeps the newest dump (and its side files), however old", () => {
    const entries = [file("old.dump", 90), file("newest.dump", 60), file("newest.dump.sha256", 60)];
    expect(expiredBackups(entries, now, 30).map((e) => e.name)).toEqual(["old.dump"]);
  });

  it("expires nothing inside the retention period", () => {
    expect(expiredBackups([file("a.dump", 29), dir("storage-private-x", 29)], now, 30)).toEqual([]);
  });
});
