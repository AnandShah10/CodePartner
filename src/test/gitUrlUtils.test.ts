import * as assert from "assert";
import { parseGitHubUrl } from "../gitUrlUtils";

suite("parseGitHubUrl", () => {
  test("parses an HTTPS URL with .git suffix", () => {
    assert.deepStrictEqual(parseGitHubUrl("https://github.com/AnandShah10/CodePartner.git"), { owner: "AnandShah10", repo: "CodePartner" });
  });

  test("parses an SSH URL with .git suffix", () => {
    assert.deepStrictEqual(parseGitHubUrl("git@github.com:AnandShah10/CodePartner.git"), { owner: "AnandShah10", repo: "CodePartner" });
  });

  test("parses an HTTPS URL without .git suffix", () => {
    assert.deepStrictEqual(parseGitHubUrl("https://github.com/AnandShah10/CodePartner"), { owner: "AnandShah10", repo: "CodePartner" });
  });

  test("parses an SSH URL without .git suffix", () => {
    assert.deepStrictEqual(parseGitHubUrl("git@github.com:AnandShah10/CodePartner"), { owner: "AnandShah10", repo: "CodePartner" });
  });

  test("handles repo names with dashes", () => {
    assert.deepStrictEqual(parseGitHubUrl("https://github.com/some-org/repo-with-dashes.git"), { owner: "some-org", repo: "repo-with-dashes" });
  });

  test("does not truncate a repo name that itself contains dots (regression case)", () => {
    assert.deepStrictEqual(parseGitHubUrl("https://github.com/some-org/repo.with.dots.git"), { owner: "some-org", repo: "repo.with.dots" });
    assert.deepStrictEqual(parseGitHubUrl("https://github.com/some-org/repo.with.dots"), { owner: "some-org", repo: "repo.with.dots" });
  });

  test("handles a trailing slash", () => {
    assert.deepStrictEqual(parseGitHubUrl("https://github.com/owner/repo.git/"), { owner: "owner", repo: "repo" });
  });

  test("returns null for a non-GitHub URL", () => {
    assert.strictEqual(parseGitHubUrl("https://gitlab.com/owner/repo.git"), null);
  });

  test("returns null for an empty string", () => {
    assert.strictEqual(parseGitHubUrl(""), null);
  });
});