import * as assert from "assert";
import { parseTestFailures } from "../testFailureParse";

suite("Phase 4 — testFailureParse", () => {
  test("extracts jest-like paths and FAIL lines", () => {
    const out = `
FAIL src/foo.test.ts
  ● does thing
    Expected: 1
    Received: 2
    at Object.<anonymous> (src/foo.test.ts:12:5)
`;
    const h = parseTestFailures(out, 1);
    assert.ok(h);
    assert.ok(h!.files.some((f) => f.includes("foo.test.ts")));
    assert.ok(h!.guidance.toLowerCase().includes("re-run") || h!.guidance.toLowerCase().includes("fix"));
  });

  test("null on success", () => {
    assert.strictEqual(parseTestFailures("ok", 0), null);
  });
});
