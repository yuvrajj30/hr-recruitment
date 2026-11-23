// Files from a task form (src/lib/tasks/form-files.ts). An unused file box arrives as an EMPTY entry: in the browser an
// empty File with no name, on the server sometimes a nameless Blob. Both must be skipped, never treated as a file.
import { describe, expect, it } from "vitest";
import { readUploads } from "@/lib/tasks/form-files";
import { TASK_LIMITS } from "@/lib/tasks/rules";

const file = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: "image/jpeg" });

describe("readUploads", () => {
  it("skips empty entries of any shape and reads real files", async () => {
    const r = await readUploads([new File([], ""), new Blob([]), "text value", file("store.jpg", 10)]);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.files.map((f) => [f.name, f.size, f.bytes.length])).toEqual([["store.jpg", 10, 10]]);
    }
    expect(await readUploads([new Blob([])])).toEqual({ ok: true, files: [] });
  });

  it("keeps a submission inside the app's 6 MB request limit: at most 3 files, 5 MB each, 5 MB in total (owner, 24 Nov)", async () => {
    expect(TASK_LIMITS).toMatchObject({ filesMax: 3, fileMaxBytes: 5 * 1024 * 1024, uploadTotalMaxBytes: 5 * 1024 * 1024 });
    // next.config.ts serverActions.bodySizeLimit is 6 MB; the files plus the form text must fit under it.
    expect(TASK_LIMITS.uploadTotalMaxBytes + 64 * 1024).toBeLessThan(6 * 1024 * 1024);
    const total = await readUploads([file("a.jpg", 3 * 1024 * 1024), file("b.jpg", 3 * 1024 * 1024)]);
    expect(total).toEqual({ ok: false, message: "Attach at most 5 MB in total. Use fewer or smaller photos." });
  });

  it(`refuses more than ${TASK_LIMITS.filesMax} files and files over 5 MB, before reading them`, async () => {
    const many = Array.from({ length: TASK_LIMITS.filesMax + 1 }, (_, i) => file(`p${i}.jpg`, 5));
    expect(await readUploads(many)).toEqual({ ok: false, message: `Attach at most ${TASK_LIMITS.filesMax} files.` });
    const big = await readUploads([file("huge.jpg", TASK_LIMITS.fileMaxBytes + 1)]);
    expect(big).toEqual({ ok: false, message: `"huge.jpg" is larger than 5 MB.` });
  });
});
