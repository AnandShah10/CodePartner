import * as assert from "assert";
import { scanForSecrets, summarizeFindings } from "../secretScanner";

suite("scanForSecrets", () => {
  test("returns nothing for ordinary code", () => {
    const findings = scanForSecrets("function add(a, b) {\n  return a + b;\n}\n");
    assert.strictEqual(findings.length, 0);
  });

  test("flags an AWS access key", () => {
    const findings = scanForSecrets("const key = 'AKIAIOSFODNN7EXAMPLE';");
    assert.ok(findings.some((f) => f.label === "AWS access key"));
  });

  test("flags an OpenAI-style API key", () => {
    const findings = scanForSecrets("OPENAI_KEY=sk-abcdefghijklmnopqrstuvwx1234");
    assert.ok(findings.some((f) => f.label === "OpenAI-style API key"));
  });

  test("flags a private key header", () => {
    const findings = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n");
    assert.ok(findings.some((f) => f.label === "Private key header"));
  });

  test("flags a .env-style secret line", () => {
    const findings = scanForSecrets("DB_PASSWORD=hunter2\nPORT=3000\n");
    assert.ok(findings.some((f) => f.label === ".env-style secret assignment"));
  });

  test("does not redact to the full original value", () => {
    const findings = scanForSecrets("const key = 'AKIAIOSFODNN7EXAMPLE';");
    assert.ok(findings[0].preview.length < "AKIAIOSFODNN7EXAMPLE".length);
  });

  test("summarizeFindings returns empty string when nothing found", () => {
    assert.strictEqual(summarizeFindings([], "file.ts"), "");
  });

  test("summarizeFindings mentions the source and label", () => {
    const findings = scanForSecrets("const key = 'AKIAIOSFODNN7EXAMPLE';");
    const summary = summarizeFindings(findings, "app.ts");
    assert.ok(summary.includes("app.ts"));
    assert.ok(summary.includes("AWS access key"));
  });
});