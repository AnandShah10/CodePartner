import * as assert from "assert";
import { scoreSkillRelevance, findAutoTriggeredSkills } from "../skillAutoTrigger";

const skills = [
  { name: "react_component_style", description: "Guidelines for writing React components with Tailwind CSS and consistent naming conventions" },
  { name: "pr_review_checklist", description: "Checklist for reviewing pull requests: tests, security, performance, style" },
  { name: "commit_message_style", description: "Format for writing git commit messages following conventional commits" },
  { name: "sql_migration_safety", description: "Rules for writing safe, backwards-compatible SQL database migrations" },
];

suite("findAutoTriggeredSkills", () => {
  test("triggers the react skill for a clearly related prompt", () => {
    const result = findAutoTriggeredSkills("Can you write me a new React component for the settings page?", skills);
    assert.ok(result.some((s) => s.name === "react_component_style"));
  });

  test("triggers the PR review skill for a clearly related prompt", () => {
    const result = findAutoTriggeredSkills("Please review this pull request for me", skills);
    assert.ok(result.some((s) => s.name === "pr_review_checklist"));
  });

  test("triggers the commit-message skill for a clearly related prompt", () => {
    const result = findAutoTriggeredSkills("write a commit message for these changes", skills);
    assert.ok(result.some((s) => s.name === "commit_message_style"));
  });

  test("triggers nothing for an unrelated prompt", () => {
    assert.strictEqual(findAutoTriggeredSkills("What is the weather like today?", skills).length, 0);
    assert.strictEqual(findAutoTriggeredSkills("explain how photosynthesis works", skills).length, 0);
  });

  test("triggers nothing for a vague prompt with no strong keyword overlap", () => {
    assert.strictEqual(findAutoTriggeredSkills("fix this bug in my code", skills).length, 0);
  });

  test("respects maxSkills even when several skills are relevant", () => {
    const result = findAutoTriggeredSkills("write a react component, review this pull request, write a commit message", skills);
    assert.ok(result.length <= 2);
    assert.ok(result.length >= 1);
  });

  test("handles an empty skills list", () => {
    assert.strictEqual(findAutoTriggeredSkills("anything", []).length, 0);
  });

  test("handles an empty prompt", () => {
    assert.strictEqual(findAutoTriggeredSkills("", skills).length, 0);
  });

  test("basic stemming: plural form of a skill keyword still matches", () => {
    assert.ok(scoreSkillRelevance("I need help with react components today", skills[0]) > 0);
  });

  test("basic stemming: gerund form of a skill keyword still matches", () => {
    assert.ok(scoreSkillRelevance("writing a new commit", skills[2]) > 0);
  });
});