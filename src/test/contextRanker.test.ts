import * as assert from "assert";
import { boostBySymbols, packToBudget } from "../contextRanker";

suite("Phase 2 — contextRanker", () => {
  test("boosts symbol path", () => {
    const ranked = boostBySymbols(
      [
        { path: "src/other.ts", score: 1.0, excerpt: "x" },
        { path: "src/PaymentService.ts", score: 0.9, excerpt: "y" },
      ],
      ["src/PaymentService.ts"],
      ["PaymentService"]
    );
    assert.ok(ranked[0].path.includes("PaymentService"));
  });

  test("packToBudget respects limit", () => {
    const packed = packToBudget(
      [
        { path: "a.ts", score: 1, excerpt: "x".repeat(400) },
        { path: "b.ts", score: 0.9, excerpt: "y".repeat(400) },
      ],
      50
    );
    assert.ok(packed.length >= 1);
    assert.ok(packed.length <= 2);
  });
});
