import * as assert from "assert";
import { isFailureWorthAssisting, shouldOfferAssist, buildAssistPrompt } from "../terminalAssist";

suite("isFailureWorthAssisting", () => {
  test("success (exit 0) is not worth assisting", () => {
    assert.strictEqual(isFailureWorthAssisting(0), false);
  });

  test("an undefined exit code is not worth assisting", () => {
    assert.strictEqual(isFailureWorthAssisting(undefined), false);
  });

  test("a genuine failure (exit 1) is worth assisting", () => {
    assert.strictEqual(isFailureWorthAssisting(1), true);
  });

  test("command-not-found (exit 127) is worth assisting", () => {
    assert.strictEqual(isFailureWorthAssisting(127), true);
  });

  test("user-initiated Ctrl+C (SIGINT, 130) is not a failure to debug", () => {
    assert.strictEqual(isFailureWorthAssisting(130), false);
  });

  test("SIGTERM (143) is not a failure to debug", () => {
    assert.strictEqual(isFailureWorthAssisting(143), false);
  });
});

suite("shouldOfferAssist", () => {
  const base = { terminalId: "t1", commandLine: "npm test", exitCode: 1, timestamp: 1000 };

  test("the first offer (no prior) is always shown", () => {
    assert.strictEqual(shouldOfferAssist(null, base), true);
  });

  test("an identical repeat within the dedupe window is suppressed", () => {
    const repeat = { ...base, timestamp: 5000 };
    assert.strictEqual(shouldOfferAssist(base, repeat, 15000), false);
  });

  test("an identical repeat after the dedupe window has passed is shown again", () => {
    const later = { ...base, timestamp: 20000 };
    assert.strictEqual(shouldOfferAssist(base, later, 15000), true);
  });

  test("a different command in the same terminal is shown", () => {
    const differentCommand = { ...base, commandLine: "npm build", timestamp: 2000 };
    assert.strictEqual(shouldOfferAssist(base, differentCommand, 15000), true);
  });

  test("the same command in a different terminal is shown", () => {
    const differentTerminal = { ...base, terminalId: "t2", timestamp: 2000 };
    assert.strictEqual(shouldOfferAssist(base, differentTerminal, 15000), true);
  });

  test("the same command with a different exit code is shown", () => {
    const differentExitCode = { ...base, exitCode: 2, timestamp: 2000 };
    assert.strictEqual(shouldOfferAssist(base, differentExitCode, 15000), true);
  });
});

suite("buildAssistPrompt", () => {
  test("includes the command, exit code, and output", () => {
    const prompt = buildAssistPrompt("npm test", 1, "Error: something broke");
    assert.ok(prompt.includes("npm test"));
    assert.ok(prompt.includes("Exit code: 1"));
    assert.ok(prompt.includes("Error: something broke"));
  });

  test("truncates long output but keeps the END, since errors are usually there", () => {
    const longOutput = "x".repeat(5000) + "IMPORTANT_ERROR_AT_END";
    const prompt = buildAssistPrompt("npm test", 1, longOutput, 100);
    assert.ok(prompt.length < longOutput.length + 500);
    assert.ok(prompt.includes("IMPORTANT_ERROR_AT_END"));
    assert.ok(prompt.includes("truncated"));
  });

  test("handles empty output gracefully", () => {
    const prompt = buildAssistPrompt("npm test", 1, "");
    assert.ok(prompt.includes("no output captured"));
  });
});