import * as assert from "assert";
import { extractSymbolsFromText, extractIdentifiersFromPrompt } from "../symbolIndex";

suite("Phase 2 — symbolIndex", () => {
  test("extracts class and function", () => {
    const text = `
export class FooBar {
  x = 1;
}
export function doThing() {}
export const helper = () => 1;
`;
    const hits = extractSymbolsFromText("src/foo.ts", text);
    const names = hits.map((h) => h.name);
    assert.ok(names.includes("FooBar"));
    assert.ok(names.includes("doThing"));
    assert.ok(names.includes("helper"));
  });

  test("extractIdentifiersFromPrompt filters stopwords", () => {
    const ids = extractIdentifiersFromPrompt("please fix the PaymentService validateOrder function");
    assert.ok(ids.some((x) => /PaymentService/i.test(x)));
    assert.ok(!ids.map((x) => x.toLowerCase()).includes("please"));
  });
});
