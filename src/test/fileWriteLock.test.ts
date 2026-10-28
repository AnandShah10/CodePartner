import * as assert from "assert";
import { withFileWriteLock } from "../fileWriteLock";

suite("fileWriteLock", () => {
  test("serializes same key", async () => {
    const order: string[] = [];
    await Promise.all([
      withFileWriteLock("a.ts", async () => {
        order.push("1s");
        await new Promise((r) => setTimeout(r, 30));
        order.push("1e");
      }),
      withFileWriteLock("a.ts", async () => {
        order.push("2s");
        order.push("2e");
      }),
    ]);
    const i1e = order.indexOf("1e");
    const i2s = order.indexOf("2s");
    assert.ok(i1e >= 0 && i2s >= 0 && i1e < i2s, order.join(","));
  });
});
