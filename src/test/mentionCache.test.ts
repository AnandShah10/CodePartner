import * as assert from "assert";
import { filterCachedFiles, isCacheFresh } from "../mentionCache";

const files = [
  { relPath: "src/extension.ts", fsPath: "/root/src/extension.ts" },
  { relPath: "src/git.ts", fsPath: "/root/src/git.ts" },
  { relPath: "media/main.js", fsPath: "/root/media/main.js" },
  { relPath: "package.json", fsPath: "/root/package.json" },
  { relPath: "src/test/git.test.ts", fsPath: "/root/src/test/git.test.ts" },
];

suite("filterCachedFiles", () => {
  test("empty query returns the first N entries, capped", () => {
    assert.strictEqual(filterCachedFiles(files, "", 3).length, 3);
    assert.deepStrictEqual(filterCachedFiles(files, "", 3), files.slice(0, 3));
  });

  test("filters by case-insensitive substring match", () => {
    const result = filterCachedFiles(files, "GIT", 20);
    assert.ok(result.every((f) => f.relPath.toLowerCase().includes("git")));
    assert.strictEqual(result.length, 2);
  });

  test("respects maxResults", () => {
    assert.strictEqual(filterCachedFiles(files, "s", 1).length, 1);
  });

  test("returns an empty array for no match", () => {
    assert.strictEqual(filterCachedFiles(files, "zzz_nonexistent", 20).length, 0);
  });
});

suite("isCacheFresh", () => {
  const now = 1_000_000;

  test("a null cache state is never fresh", () => {
    assert.strictEqual(isCacheFresh(null, 5000, now), false);
  });

  test("a recent cache entry is fresh", () => {
    assert.strictEqual(isCacheFresh({ files: [], fetchedAt: now - 1000 }, 5000, now), true);
  });

  test("an old cache entry is stale", () => {
    assert.strictEqual(isCacheFresh({ files: [], fetchedAt: now - 6000 }, 5000, now), false);
  });

  test("exactly at the boundary counts as stale", () => {
    assert.strictEqual(isCacheFresh({ files: [], fetchedAt: now - 5000 }, 5000, now), false);
  });
});