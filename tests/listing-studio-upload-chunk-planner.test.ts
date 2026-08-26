import { describe, expect, it } from "vitest";
import { planUploadChunks, totalPlannedFiles, type PlannableFile } from "@/lib/listing-studio/upload-chunk-planner";
import { MAX_BATCH_SIZE_BYTES, MAX_FILES_PER_SELECTION, MAX_INDIVIDUAL_FILE_SIZE_BYTES } from "@/lib/listing-studio/upload-limits";

function makeFiles(count: number, sizeBytes = 800 * 1024): PlannableFile[] {
  return Array.from({ length: count }, (_, index) => ({ name: `IMG_${String(index + 1).padStart(4, "0")}.JPEG`, size: sizeBytes }));
}

describe("planUploadChunks — count boundaries", () => {
  it("1 file -> 1 chunk of 1", () => {
    const plan = planUploadChunks(makeFiles(1));
    expect(plan.chunks).toEqual([makeFiles(1)]);
    expect(plan.rejected).toEqual([]);
  });

  it(`${MAX_FILES_PER_SELECTION} files (exactly the server ceiling) -> exactly 1 chunk`, () => {
    const plan = planUploadChunks(makeFiles(MAX_FILES_PER_SELECTION));
    expect(plan.chunks.length).toBe(1);
    expect(plan.chunks[0].length).toBe(MAX_FILES_PER_SELECTION);
  });

  it(`${MAX_FILES_PER_SELECTION + 1} files -> 2 chunks (60 + 1), never one oversized request`, () => {
    const plan = planUploadChunks(makeFiles(MAX_FILES_PER_SELECTION + 1));
    expect(plan.chunks.length).toBe(2);
    expect(plan.chunks[0].length).toBe(MAX_FILES_PER_SELECTION);
    expect(plan.chunks[1].length).toBe(1);
  });

  it("REQUIREMENT: 126 files (the confirmed failing selection) -> 60, 60, 6", () => {
    const plan = planUploadChunks(makeFiles(126));
    expect(plan.chunks.map(chunk => chunk.length)).toEqual([60, 60, 6]);
  });

  it("120 files -> 60, 60", () => {
    const plan = planUploadChunks(makeFiles(120));
    expect(plan.chunks.map(chunk => chunk.length)).toEqual([60, 60]);
  });

  it("150 files -> 60, 60, 30", () => {
    const plan = planUploadChunks(makeFiles(150));
    expect(plan.chunks.map(chunk => chunk.length)).toEqual([60, 60, 30]);
  });

  it("300 files -> five chunks of 60, none exceeding the server ceiling", () => {
    const plan = planUploadChunks(makeFiles(300));
    expect(plan.chunks.length).toBe(5);
    for (const chunk of plan.chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_FILES_PER_SELECTION);
  });

  it("REQUIREMENT: no chunk ever exceeds MAX_FILES_PER_SELECTION, across a wide sweep of selection sizes", () => {
    for (const count of [1, 2, 59, 60, 61, 62, 100, 119, 120, 121, 125, 126, 127, 150, 200, 299, 300, 301]) {
      const plan = planUploadChunks(makeFiles(count));
      for (const chunk of plan.chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_FILES_PER_SELECTION);
    }
  });
});

describe("planUploadChunks — byte boundaries", () => {
  it("REQUIREMENT: no chunk ever exceeds MAX_BATCH_SIZE_BYTES in combined size", () => {
    // 20 files at 30MB each = 600MB combined, well past the 500MB ceiling,
    // and well under the 60-file count ceiling too — only the byte ceiling
    // should split this.
    const files = makeFiles(20, 30 * 1024 * 1024);
    const plan = planUploadChunks(files);
    for (const chunk of plan.chunks) {
      const totalBytes = chunk.reduce((sum, file) => sum + file.size, 0);
      expect(totalBytes).toBeLessThanOrEqual(MAX_BATCH_SIZE_BYTES);
    }
    expect(totalPlannedFiles(plan)).toBe(20);
  });

  it("a chunk closes exactly when the NEXT file would push it over the byte ceiling, not before — using files at the individual-size cap (the largest a single file may legally be)", () => {
    const maxPerChunkByBytes = Math.floor(MAX_BATCH_SIZE_BYTES / MAX_INDIVIDUAL_FILE_SIZE_BYTES); // 14
    const files = makeFiles(maxPerChunkByBytes + 1, MAX_INDIVIDUAL_FILE_SIZE_BYTES);
    const plan = planUploadChunks(files);
    expect(plan.chunks.length).toBe(2);
    expect(plan.chunks[0].length).toBe(maxPerChunkByBytes);
    expect(plan.chunks[1].length).toBe(1);
  });

  it("mixed file sizes never assume uniformity — a run of max-size files closes a chunk well before the 60-file count ceiling would suggest", () => {
    const files: PlannableFile[] = [
      ...makeFiles(15, MAX_INDIVIDUAL_FILE_SIZE_BYTES), // 15 x 35MB = 525MB, over the batch ceiling alone
      ...makeFiles(5, 800 * 1024).map((f, i) => ({ ...f, name: `small_${i}.jpg` })),
    ];
    const plan = planUploadChunks(files);
    expect(plan.chunks.length).toBeGreaterThan(1); // the byte ceiling forced a split well under 60 files
    for (const chunk of plan.chunks) {
      const totalBytes = chunk.reduce((sum, file) => sum + file.size, 0);
      expect(totalBytes).toBeLessThanOrEqual(MAX_BATCH_SIZE_BYTES);
      expect(chunk.length).toBeLessThanOrEqual(MAX_FILES_PER_SELECTION);
    }
    expect(totalPlannedFiles(plan)).toBe(20);
  });
});

describe("planUploadChunks — individual oversized files", () => {
  it("REQUIREMENT: a single file over MAX_INDIVIDUAL_FILE_SIZE_BYTES is rejected with a clear reason, not silently dropped and not blocking the rest", () => {
    const files: PlannableFile[] = [
      { name: "IMG_0001.JPEG", size: 800 * 1024 },
      { name: "IMG_5050.JPEG", size: MAX_INDIVIDUAL_FILE_SIZE_BYTES + 1 },
      { name: "IMG_0003.JPEG", size: 800 * 1024 },
    ];
    const plan = planUploadChunks(files);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].file.name).toBe("IMG_5050.JPEG");
    expect(plan.rejected[0].reason).toBe("file_too_large");
    expect(plan.rejected[0].message).toContain("IMG_5050.JPEG");
    expect(plan.rejected[0].message).toContain("35MB");
    expect(plan.chunks.flat().map(file => file.name)).toEqual(["IMG_0001.JPEG", "IMG_0003.JPEG"]);
  });

  it("a file exactly AT the individual limit is accepted, not rejected", () => {
    const files: PlannableFile[] = [{ name: "exact.jpg", size: MAX_INDIVIDUAL_FILE_SIZE_BYTES }];
    const plan = planUploadChunks(files);
    expect(plan.rejected).toEqual([]);
    expect(totalPlannedFiles(plan)).toBe(1);
  });

  it("several oversized files scattered through a selection are all rejected, order-independent of position", () => {
    const files: PlannableFile[] = [
      { name: "ok1.jpg", size: 1000 },
      { name: "big1.jpg", size: MAX_INDIVIDUAL_FILE_SIZE_BYTES + 1 },
      { name: "ok2.jpg", size: 1000 },
      { name: "big2.jpg", size: MAX_INDIVIDUAL_FILE_SIZE_BYTES + 1000 },
      { name: "ok3.jpg", size: 1000 },
    ];
    const plan = planUploadChunks(files);
    expect(plan.rejected.map(r => r.file.name)).toEqual(["big1.jpg", "big2.jpg"]);
    expect(plan.chunks.flat().map(file => file.name)).toEqual(["ok1.jpg", "ok2.jpg", "ok3.jpg"]);
  });
});

describe("planUploadChunks — order preservation, no duplication, no omission", () => {
  it("REQUIREMENT: preserves exact input order across chunk boundaries — never sorted by filename", () => {
    // Deliberately non-alphabetical names so a filename-sort bug would be caught.
    const files: PlannableFile[] = Array.from({ length: 65 }, (_, i) => ({ name: `zzz_${64 - i}.jpg`, size: 500 }));
    const plan = planUploadChunks(files);
    expect(plan.chunks.flat().map(f => f.name)).toEqual(files.map(f => f.name));
  });

  it("REQUIREMENT: every accepted file appears in exactly one chunk — no duplicate membership, no missing membership", () => {
    const files = makeFiles(126);
    const plan = planUploadChunks(files);
    const flat = plan.chunks.flat();
    expect(flat.length).toBe(files.length);
    const names = flat.map(f => f.name);
    expect(new Set(names).size).toBe(names.length); // no duplicates
    expect(new Set(names)).toEqual(new Set(files.map(f => f.name))); // no omissions
  });

  it("handles non-numeric / mixed filenames without special-casing them", () => {
    const files: PlannableFile[] = [
      { name: "product-front.jpg", size: 500 },
      { name: "IMG_0002.jpg", size: 500 },
      { name: "スマホ写真.jpg", size: 500 },
      { name: "photo (1).jpeg", size: 500 },
      { name: "no-extension-in-name-shown-here", size: 500 },
    ];
    const plan = planUploadChunks(files);
    expect(plan.chunks.flat().map(f => f.name)).toEqual(files.map(f => f.name));
  });

  it("the final file of one chunk and the first file of the next chunk are adjacent in original order (no gap, no swap)", () => {
    const files = makeFiles(65);
    const plan = planUploadChunks(files);
    expect(plan.chunks[0][plan.chunks[0].length - 1].name).toBe("IMG_0060.JPEG");
    expect(plan.chunks[1][0].name).toBe("IMG_0061.JPEG");
  });
});

describe("planUploadChunks — workspace capacity truncation", () => {
  it("REQUIREMENT: truncates the tail when the selection exceeds remaining capacity, keeping the first files in order", () => {
    const files = makeFiles(120);
    const plan = planUploadChunks(files, 80);
    expect(totalPlannedFiles(plan)).toBe(80);
    expect(plan.rejected).toHaveLength(40);
    expect(plan.rejected.every(r => r.reason === "workspace_capacity_exceeded")).toBe(true);
    expect(plan.chunks.flat().map(f => f.name)).toEqual(files.slice(0, 80).map(f => f.name));
    expect(plan.rejected.map(r => r.file.name)).toEqual(files.slice(80).map(f => f.name));
  });

  it("zero remaining capacity rejects everything, none silently dropped (each has a reason)", () => {
    const files = makeFiles(5);
    const plan = planUploadChunks(files, 0);
    expect(plan.chunks).toEqual([]);
    expect(plan.rejected).toHaveLength(5);
  });

  it("capacity exactly matching the selection size accepts everything", () => {
    const files = makeFiles(10);
    const plan = planUploadChunks(files, 10);
    expect(totalPlannedFiles(plan)).toBe(10);
    expect(plan.rejected).toEqual([]);
  });

  it("capacity larger than the selection has no effect", () => {
    const files = makeFiles(10);
    const plan = planUploadChunks(files, 999);
    expect(totalPlannedFiles(plan)).toBe(10);
    expect(plan.rejected).toEqual([]);
  });

  it("no capacity argument (undefined/null) applies no capacity truncation at all", () => {
    const files = makeFiles(120);
    expect(totalPlannedFiles(planUploadChunks(files))).toBe(120);
    expect(totalPlannedFiles(planUploadChunks(files, null))).toBe(120);
  });

  it("capacity truncation and individual-oversized rejection compose correctly together", () => {
    const files: PlannableFile[] = [
      ...makeFiles(3), // 3 ok
      { name: "huge.jpg", size: MAX_INDIVIDUAL_FILE_SIZE_BYTES + 1 }, // rejected for size, not counted against capacity
      ...makeFiles(3).map((f, i) => ({ ...f, name: `more_${i}.jpg` })), // 3 more ok
    ];
    // remaining capacity 4: of the 6 size-acceptable files, only the first 4 fit.
    const plan = planUploadChunks(files, 4);
    const sizeRejected = plan.rejected.filter(r => r.reason === "file_too_large");
    const capacityRejected = plan.rejected.filter(r => r.reason === "workspace_capacity_exceeded");
    expect(sizeRejected).toHaveLength(1);
    expect(sizeRejected[0].file.name).toBe("huge.jpg");
    expect(capacityRejected).toHaveLength(2);
    expect(totalPlannedFiles(plan)).toBe(4);
  });
});

describe("planUploadChunks — empty input", () => {
  it("an empty selection plans zero chunks and rejects nothing", () => {
    const plan = planUploadChunks([]);
    expect(plan.chunks).toEqual([]);
    expect(plan.rejected).toEqual([]);
  });
});
