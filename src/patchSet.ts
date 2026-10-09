/**
 * Multi-file transactional PatchSet.
 *
 * Collects agent file edits during a turn, supports commit (keep all) or
 * rollback (restore all pre snapshots), and 3-way merge when the user
 * edited a file after the agent.
 */

import * as fs from "fs";
import * as path from "path";
import { diffLines } from "./lineDiff";
import { merge3, Merge3Result } from "./merge3";

export interface PatchRegion {
  oldBlock: string;
  newBlock: string;
}

export interface FilePatch {
  path: string;
  preContent: string;
  postContent: string;
  regions: PatchRegion[];
  created: boolean;
}

export interface PatchSet {
  id: string;
  turnId?: string | number;
  createdAt: number;
  status: "open" | "committed" | "rolled_back" | "partial";
  files: FilePatch[];
}

export type FileApplyMode = "agent" | "current" | "merged" | "conflict";

export interface FileApplyResult {
  path: string;
  mode: FileApplyMode;
  content?: string;
  merge?: Merge3Result;
  error?: string;
}

function extractRegions(pre: string, post: string): PatchRegion[] {
  const lines = diffLines(pre, post);
  const regions: PatchRegion[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "context") {
      i++;
      continue;
    }
    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (i < lines.length && lines[i].type !== "context") {
      if (lines[i].type === "remove") {
        oldLines.push(lines[i].value);
      } else if (lines[i].type === "add") {
        newLines.push(lines[i].value);
      }
      i++;
    }
    regions.push({
      oldBlock: oldLines.join("\n"),
      newBlock: newLines.join("\n"),
    });
  }
  return regions;
}

export function buildFilePatch(
  filePath: string,
  preContent: string,
  postContent: string,
  created = false
): FilePatch {
  return {
    path: filePath,
    preContent,
    postContent,
    regions: created ? [] : extractRegions(preContent, postContent),
    created,
  };
}

export function createPatchSet(
  files: FilePatch[],
  turnId?: string | number
): PatchSet {
  return {
    id: `patch-${Date.now().toString(36)}`,
    turnId,
    createdAt: Date.now(),
    status: "open",
    files,
  };
}

/**
 * Active transaction: accumulate file patches, then commit or rollback on disk.
 */
export class PatchTransaction {
  readonly id: string;
  readonly turnId?: string | number;
  readonly createdAt: number;
  private files = new Map<string, FilePatch>();
  status: PatchSet["status"] = "open";

  constructor(turnId?: string | number) {
    this.id = `patch-${Date.now().toString(36)}`;
    this.turnId = turnId;
    this.createdAt = Date.now();
  }

  record(
    relPath: string,
    preContent: string,
    postContent: string,
    created = false
  ): void {
    const key = relPath.replace(/\\/g, "/");
    const existing = this.files.get(key);
    const pre = existing ? existing.preContent : preContent;
    const wasCreated = existing ? existing.created || created : created;
    this.files.set(key, buildFilePatch(key, pre, postContent, wasCreated));
  }

  getFile(relPath: string): FilePatch | undefined {
    return this.files.get(relPath.replace(/\\/g, "/"));
  }

  list(): FilePatch[] {
    return Array.from(this.files.values());
  }

  toPatchSet(): PatchSet {
    return {
      id: this.id,
      turnId: this.turnId,
      createdAt: this.createdAt,
      status: this.status,
      files: this.list(),
    };
  }

  rollback(resolvePath: (rel: string) => string): { restored: string[]; errors: string[] } {
    const restored: string[] = [];
    const errors: string[] = [];
    for (const fp of this.files.values()) {
      try {
        const abs = resolvePath(fp.path);
        if (fp.created) {
          if (fs.existsSync(abs)) {
            fs.unlinkSync(abs);
          }
        } else {
          const dir = path.dirname(abs);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(abs, fp.preContent, "utf8");
        }
        restored.push(fp.path);
      } catch (e: any) {
        errors.push(`${fp.path}: ${e.message}`);
      }
    }
    this.status = errors.length ? "partial" : "rolled_back";
    return { restored, errors };
  }

  commit(
    resolvePath: (rel: string) => string,
    reapply = false
  ): { applied: string[]; errors: string[] } {
    const applied: string[] = [];
    const errors: string[] = [];
    if (reapply) {
      for (const fp of this.files.values()) {
        try {
          const abs = resolvePath(fp.path);
          const dir = path.dirname(abs);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(abs, fp.postContent, "utf8");
          applied.push(fp.path);
        } catch (e: any) {
          errors.push(`${fp.path}: ${e.message}`);
        }
      }
    } else {
      for (const fp of this.files.values()) {
        applied.push(fp.path);
      }
    }
    this.status = errors.length ? "partial" : "committed";
    return { applied, errors };
  }

  reviewAgainstDisk(resolvePath: (rel: string) => string): FileApplyResult[] {
    const results: FileApplyResult[] = [];
    for (const fp of this.files.values()) {
      try {
        const abs = resolvePath(fp.path);
        if (fp.created && !fs.existsSync(abs)) {
          results.push({ path: fp.path, mode: "agent", content: fp.postContent });
          continue;
        }
        const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
        if (current === fp.postContent) {
          results.push({ path: fp.path, mode: "agent", content: current });
        } else if (current === fp.preContent) {
          results.push({ path: fp.path, mode: "current", content: current });
        } else {
          const m = merge3(fp.preContent, current, fp.postContent);
          results.push({
            path: fp.path,
            mode: m.conflicted ? "conflict" : "merged",
            content: m.content,
            merge: m,
          });
        }
      } catch (e: any) {
        results.push({ path: fp.path, mode: "conflict", error: e.message });
      }
    }
    return results;
  }
}
