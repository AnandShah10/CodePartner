import * as assert from "assert";
import { assessSandboxedCommand, buildSandboxEnv, getSandboxMode } from "../sandbox";

suite("sandbox", () => {
  test("getSandboxMode defaults soft", () => {
    assert.strictEqual(getSandboxMode(undefined), "soft");
    assert.strictEqual(getSandboxMode("strict"), "strict");
  });

  test("soft allows npm test", () => {
    const r = assessSandboxedCommand("npm test", "soft");
    assert.strictEqual(r.allow, true);
    assert.ok(r.env);
  });

  test("strict blocks curl", () => {
    const r = assessSandboxedCommand("curl https://evil.example", "strict");
    assert.strictEqual(r.allow, false);
  });

  test("strict allows curl under yolo", () => {
    const r = assessSandboxedCommand("curl https://example.com", "strict", { yolo: true });
    assert.strictEqual(r.allow, true);
  });

  test("always blocks rm -rf /", () => {
    const r = assessSandboxedCommand("rm -rf /", "soft");
    assert.strictEqual(r.allow, false);
  });

  test("buildSandboxEnv strips secrets", () => {
    const env = buildSandboxEnv({
      PATH: "/usr/bin",
      API_SECRET_KEY: "x",
      HOME: "/home/u",
    } as any);
    assert.strictEqual(env.PATH, "/usr/bin");
    assert.ok(!env.API_SECRET_KEY);
    assert.strictEqual(env.CODEPARTNER_SANDBOX, "1");
  });
});
