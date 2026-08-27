import * as assert from "assert";
import { diffLines, groupIntoHunks, applyAcceptedHunks } from "../lineDiff";

suite("diffLines / groupIntoHunks / applyAcceptedHunks", () => {
  test("identical texts produce no hunks", () => {
    const same = "a\nb\nc";
    const dl = diffLines(same, same);
    assert.ok(dl.every((l) => l.type === "context"));
    assert.strictEqual(groupIntoHunks(dl).length, 0);
  });

  test("two widely-separated changes produce two distinct hunks", () => {
    const oldArr: string[] = [];
    const newArr: string[] = [];
    for (let i = 1; i <= 20; i++) {
      oldArr.push(`line${i}`);
      newArr.push(i === 2 ? "CHANGED2" : i === 18 ? "CHANGED18" : `line${i}`);
    }
    const dl = diffLines(oldArr.join("\n"), newArr.join("\n"));
    const hunks = groupIntoHunks(dl, 3);
    assert.strictEqual(hunks.length, 2);
  });

  test("a gap of exactly 2*context merges into a single hunk (matches unified-diff boundary behavior)", () => {
    const oldArr: string[] = [];
    const newArr: string[] = [];
    for (let i = 1; i <= 10; i++) {
      oldArr.push(`line${i}`);
      newArr.push(i === 2 ? "X2" : i === 9 ? "X9" : `line${i}`);
    }
    const dl = diffLines(oldArr.join("\n"), newArr.join("\n"));
    assert.strictEqual(groupIntoHunks(dl, 3).length, 1);
  });

  test("accepting all hunks reconstructs the new text exactly", () => {
    const oldText = "a\nb\nc\nd\ne";
    const newText = "a\nX\nc\nd\nY";
    const dl = diffLines(oldText, newText);
    const hunks = groupIntoHunks(dl, 1);
    const result = applyAcceptedHunks(dl, hunks, new Set(hunks.map((h) => h.id)));
    assert.strictEqual(result, newText);
  });

  test("accepting no hunks reconstructs the original text exactly", () => {
    const oldText = "a\nb\nc\nd\ne";
    const newText = "a\nX\nc\nd\nY";
    const dl = diffLines(oldText, newText);
    const hunks = groupIntoHunks(dl, 1);
    const result = applyAcceptedHunks(dl, hunks, new Set());
    assert.strictEqual(result, oldText);
  });

  test("mixed accept/reject applies only the chosen hunks — the actual point of per-hunk review", () => {
    const oldArr: string[] = [];
    const newArr: string[] = [];
    for (let i = 1; i <= 20; i++) {
      oldArr.push(`line${i}`);
      newArr.push(i === 2 ? "CHANGED2" : i === 18 ? "CHANGED18" : `line${i}`);
    }
    const dl = diffLines(oldArr.join("\n"), newArr.join("\n"));
    const hunks = groupIntoHunks(dl, 3);
    assert.strictEqual(hunks.length, 2);

    const acceptFirstOnly = applyAcceptedHunks(dl, hunks, new Set([hunks[0].id])).split("\n");
    assert.ok(acceptFirstOnly.includes("CHANGED2"));
    assert.ok(acceptFirstOnly.includes("line18"));
    assert.ok(!acceptFirstOnly.includes("CHANGED18"));

    const acceptSecondOnly = applyAcceptedHunks(dl, hunks, new Set([hunks[1].id])).split("\n");
    assert.ok(acceptSecondOnly.includes("CHANGED18"));
    assert.ok(acceptSecondOnly.includes("line2"));
    assert.ok(!acceptSecondOnly.includes("CHANGED2"));
  });

  test("a brand-new file (empty oldText) produces one all-additions hunk", () => {
    const dl = diffLines("", "new line 1\nnew line 2");
    const hunks = groupIntoHunks(dl, 3);
    assert.strictEqual(hunks.length, 1);
    assert.ok(hunks[0].lines.every((l) => l.type === "add"));
    assert.strictEqual(applyAcceptedHunks(dl, hunks, new Set(hunks.map((h) => h.id))), "new line 1\nnew line 2");
    assert.strictEqual(applyAcceptedHunks(dl, hunks, new Set()), "");
  });

  test("a full deletion produces one all-removals hunk", () => {
    const dl = diffLines("a\nb\nc", "");
    const hunks = groupIntoHunks(dl, 3);
    assert.strictEqual(hunks.length, 1);
    assert.ok(hunks[0].lines.every((l) => l.type === "remove"));
    assert.strictEqual(applyAcceptedHunks(dl, hunks, new Set(hunks.map((h) => h.id))), "");
    assert.strictEqual(applyAcceptedHunks(dl, hunks, new Set()), "a\nb\nc");
  });
});