/**
 * Local async agents — background work in the extension host (no cloud backend).
 * Job metadata can be persisted to disk and restored after reload; running
 * work does not continue after VS Code exits.
 */

import * as fs from "fs";
import * as path from "path";

export type AsyncJobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface AsyncJob {
  id: string;
  title: string;
  prompt: string;
  status: AsyncJobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}

let nextId = 1;

export class AsyncAgentQueue {
  private jobs = new Map<string, AsyncJob>();
  private maxJobs = 30;
  private persistPath?: string;

  /** Optional path under globalStorage for job list persistence across reloads. */
  setPersistPath(filePath: string): void {
    this.persistPath = filePath;
    this.loadFromDisk();
  }

  list(): AsyncJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): AsyncJob | undefined {
    return this.jobs.get(id);
  }

  create(title: string, prompt: string): AsyncJob {
    const job: AsyncJob = {
      id: `async-${nextId++}`,
      title: title.slice(0, 120) || "Background agent",
      prompt,
      status: "queued",
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.trim();
    this.saveToDisk();
    return job;
  }

  markRunning(id: string): void {
    const j = this.jobs.get(id);
    if (!j) {
      return;
    }
    j.status = "running";
    j.startedAt = Date.now();
    this.saveToDisk();
  }

  markDone(id: string, result: string): void {
    const j = this.jobs.get(id);
    if (!j) {
      return;
    }
    j.status = "done";
    j.finishedAt = Date.now();
    j.result = result.slice(0, 50_000);
    this.saveToDisk();
  }

  markError(id: string, error: string): void {
    const j = this.jobs.get(id);
    if (!j) {
      return;
    }
    j.status = "error";
    j.finishedAt = Date.now();
    j.error = error.slice(0, 4000);
    this.saveToDisk();
  }

  markCancelled(id: string): void {
    const j = this.jobs.get(id);
    if (!j) {
      return;
    }
    j.status = "cancelled";
    j.finishedAt = Date.now();
    this.saveToDisk();
  }

  formatList(): string {
    const all = this.list();
    if (all.length === 0) {
      return "No async agent jobs yet.";
    }
    return all
      .map((j) => {
        const dur =
          j.startedAt && j.finishedAt
            ? `${Math.round((j.finishedAt - j.startedAt) / 1000)}s`
            : j.status === "running"
              ? "running…"
              : "";
        const tail =
          j.status === "done"
            ? (j.result || "").slice(0, 120).replace(/\n/g, " ")
            : j.status === "error"
              ? j.error
              : "";
        return `- [${j.status}] ${j.id} — ${j.title}${dur ? ` (${dur})` : ""}${tail ? `\n  ${tail}` : ""}`;
      })
      .join("\n");
  }

  private trim(): void {
    const all = this.list();
    if (all.length <= this.maxJobs) {
      return;
    }
    for (const j of all.slice(this.maxJobs)) {
      this.jobs.delete(j.id);
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) {
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath, "utf8")) as AsyncJob[];
      if (!Array.isArray(raw)) {
        return;
      }
      for (const j of raw) {
        // Jobs left "running" when VS Code quit are not still running
        if (j.status === "running" || j.status === "queued") {
          j.status = "cancelled";
          j.error = j.error || "Interrupted when the editor closed.";
          j.finishedAt = j.finishedAt || Date.now();
        }
        this.jobs.set(j.id, j);
        const n = parseInt(String(j.id).replace(/\D/g, ""), 10);
        if (!isNaN(n) && n >= nextId) {
          nextId = n + 1;
        }
      }
    } catch {
      /* ignore corrupt file */
    }
  }

  private saveToDisk(): void {
    if (!this.persistPath) {
      return;
    }
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.persistPath,
        JSON.stringify(this.list().slice(0, this.maxJobs), null, 0),
        "utf8"
      );
    } catch {
      /* ignore */
    }
  }
}
