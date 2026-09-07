import * as assert from "assert";
import { stripAnsiCodes } from "../ansiStrip";

suite("stripAnsiCodes", () => {
  test("strips a basic color code", () => {
    assert.strictEqual(stripAnsiCodes("\x1b[32msuccess\x1b[0m"), "success");
  });

  test("strips a bold+color combination", () => {
    assert.strictEqual(stripAnsiCodes("\x1b[1;31merror\x1b[0m: failed"), "error: failed");
  });

  test("strips cursor-movement sequences (progress bars)", () => {
    assert.strictEqual(stripAnsiCodes("\x1b[2K\x1b[1Gloading..."), "loading...");
  });

  test("strips an OSC sequence terminated by BEL", () => {
    assert.strictEqual(stripAnsiCodes("\x1b]0;my title\x07hello"), "hello");
  });

  test("strips an OSC sequence terminated by ESC-backslash (ST)", () => {
    assert.strictEqual(stripAnsiCodes("\x1b]0;my title\x1b\\hello"), "hello");
  });

  test("removes bare carriage returns used for in-place progress updates", () => {
    const result = stripAnsiCodes("50%\r100%");
    assert.ok(result.includes("100%"));
    assert.ok(!result.includes("\r"));
  });

  test("leaves plain text unchanged", () => {
    assert.strictEqual(stripAnsiCodes("npm install completed successfully"), "npm install completed successfully");
  });

  test("cleans a realistic multi-line colored test-runner output", () => {
    const realistic = "\x1b[32m✓\x1b[0m test one passed\n\x1b[32m✓\x1b[0m test two passed\n\x1b[1mAll tests passed\x1b[0m";
    assert.strictEqual(stripAnsiCodes(realistic), "✓ test one passed\n✓ test two passed\nAll tests passed");
  });

  test("handles empty input safely", () => {
    assert.strictEqual(stripAnsiCodes(""), "");
  });
});