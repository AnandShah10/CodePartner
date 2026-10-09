/**
 * Deeper auto-verification (local, no model decision).
 * Maps changed source files → likely test files and builds a focused test command.
 */

import * as fs from "fs";
import * as path from "path";

export interface AutoVerifyPlan {
  command: string;
  testFiles: string[];
  reason: string;
}

function exists(root: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(root, rel));
  } catch {
    return false;
  }
}

/**
 * Heuristic: foo.ts → foo.test.ts / foo.spec.ts / __tests__/foo.test.ts etc.
 */
export function findRelatedTestFiles(root: string, changedRelPaths: string[]): string[] {
  const found = new Set<string>();
  for (const rel of changedRelPaths) {
    const norm = rel.replace(/\\/g, "/");
    // Already a test file
    if (/\.(test|spec)\.(t|j)sx?$/i.test(norm) || /\/__tests__\//i.test(norm)) {
      if (exists(root, norm)) {
        found.add(norm);
      }
      continue;
    }
    const ext = path.extname(norm);
    const base = norm.slice(0, -ext.length);
    const dir = path.posix.dirname(norm);
    const name = path.posix.basename(base);
    const candidates = [
      `${base}.test${ext}`,
      `${base}.spec${ext}`,
      `${base}.test.ts`,
      `${base}.test.tsx`,
      `${base}.spec.ts`,
      `${base}.spec.tsx`,
      `${base}.test.js`,
      `${base}.spec.js`,
      `${dir}/__tests__/${name}.test${ext}`,
      `${dir}/__tests__/${name}.spec${ext}`,
      `${dir}/__tests__/${name}.test.ts`,
      `${dir}/__tests__/${name}.ts`,
      // Python
      `${base}_test.py`,
      `${dir}/test_${name}.py`,
      `tests/${name}_test.py`,
      `tests/test_${name}.py`,
    ];
    for (const c of candidates) {
      const cleaned = c.replace(/^\.\//, "");
      if (exists(root, cleaned)) {
        found.add(cleaned);
      }
    }
  }
  return Array.from(found).slice(0, 12);
}

export type DetectedRunner = "vitest" | "jest" | "mocha" | "pytest" | "npm" | "unknown";

export function detectRunner(root: string): { runner: DetectedRunner; baseCommand: string } {
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps?.vitest) {
        return { runner: "vitest", baseCommand: "npx vitest run" };
      }
      if (deps?.jest) {
        return { runner: "jest", baseCommand: "npx jest --no-coverage" };
      }
      if (deps?.mocha) {
        return { runner: "mocha", baseCommand: "npx mocha" };
      }
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        return { runner: "npm", baseCommand: "npm test" };
      }
    } catch { /* ignore */ }
  }
  if (
    fs.existsSync(path.join(root, "pytest.ini")) ||
    fs.existsSync(path.join(root, "pyproject.toml")) ||
    fs.existsSync(path.join(root, "setup.py"))
  ) {
    return { runner: "pytest", baseCommand: "python -m pytest --tb=short -q" };
  }
  return { runner: "unknown", baseCommand: "" };
}

/**
 * Build a focused test command for changed files. Falls back to suite command.
 */
export function planAutoVerify(
  root: string,
  changedRelPaths: string[],
  mode: "focused" | "full"
): AutoVerifyPlan | null {
  const { runner, baseCommand } = detectRunner(root);
  if (!baseCommand) {
    return null;
  }
  if (mode === "full" || changedRelPaths.length === 0) {
    return {
      command: baseCommand,
      testFiles: [],
      reason: "full suite",
    };
  }
  const testFiles = findRelatedTestFiles(root, changedRelPaths);
  if (testFiles.length === 0) {
    return {
      command: baseCommand,
      testFiles: [],
      reason: "no related test files found — full suite",
    };
  }
  const quoted = testFiles.map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(" ");
  switch (runner) {
    case "vitest":
      return {
        command: `npx vitest run ${quoted}`,
        testFiles,
        reason: `focused vitest on ${testFiles.length} file(s)`,
      };
    case "jest":
      return {
        command: `npx jest --no-coverage ${quoted}`,
        testFiles,
        reason: `focused jest on ${testFiles.length} file(s)`,
      };
    case "mocha":
      return {
        command: `npx mocha ${quoted}`,
        testFiles,
        reason: `focused mocha on ${testFiles.length} file(s)`,
      };
    case "pytest":
      return {
        command: `python -m pytest --tb=short -q ${quoted}`,
        testFiles,
        reason: `focused pytest on ${testFiles.length} file(s)`,
      };
    case "npm":
    default:
      // npm test often ignores file args — still prefer suite
      return {
        command: baseCommand,
        testFiles,
        reason: "npm test script (cannot always pass files) — suite; related: " + testFiles.join(", "),
      };
  }
}
