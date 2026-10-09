/**
 * Local agent sandbox (no CodePartner backend).
 *
 * Modes:
 * - off:   no extra restrictions beyond path containment elsewhere
 * - soft:  commandSafety + filtered env + network-command warnings
 * - strict: soft + block outbound network patterns, force approval for
 *           installers, optional bubblewrap isolation on Linux when present
 *
 * This is not a VM/container product — it reduces blast radius in the
 * extension host. Real OS isolation still requires the user's OS tools
 * (bubblewrap/firejail) when available.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assessCommand, CommandSafetyResult } from "./commandSafety";

export type SandboxMode = "off" | "soft" | "strict";

export interface SandboxAssessment {
  allow: boolean;
  reason?: string;
  /** Command actually executed (may be wrapped) */
  effectiveCommand: string;
  /** Env to pass to spawn (undefined = inherit process.env as filtered) */
  env?: NodeJS.ProcessEnv;
  notes: string[];
}

/** Patterns that imply outbound network or package install (strict mode). */
const NETWORK_OR_INSTALL: Array<{ re: RegExp; reason: string }> = [
  { re: /\bcurl\b/i, reason: "network: curl" },
  { re: /\bwget\b/i, reason: "network: wget" },
  { re: /\bssh\b/i, reason: "network: ssh" },
  { re: /\bscp\b/i, reason: "network: scp" },
  { re: /\bftp\b/i, reason: "network: ftp" },
  { re: /\bnc\s+-/i, reason: "network: netcat" },
  { re: /\bnpm\s+install\b/i, reason: "package install: npm" },
  { re: /\bpnpm\s+install\b/i, reason: "package install: pnpm" },
  { re: /\byarn\s+add\b/i, reason: "package install: yarn" },
  { re: /\bpip\s+install\b/i, reason: "package install: pip" },
  { re: /\bgo\s+get\b/i, reason: "package install: go get" },
  { re: /\bdocker\s+pull\b/i, reason: "network: docker pull" },
  { re: /\bgit\s+clone\b/i, reason: "network: git clone" },
];

let bwrapAvailable: boolean | undefined;

export function detectBubblewrap(): boolean {
  if (bwrapAvailable !== undefined) {
    return bwrapAvailable;
  }
  if (process.platform !== "linux") {
    bwrapAvailable = false;
    return false;
  }
  for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap"]) {
    if (fs.existsSync(candidate)) {
      bwrapAvailable = true;
      return true;
    }
  }
  bwrapAvailable = false;
  return false;
}

/**
 * Build a reduced environment for sandboxed processes.
 * Keeps PATH/HOME/USER/LANG and common build vars; drops obvious secrets.
 */
export function buildSandboxEnv(
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const keep = new Set([
    "PATH",
    "HOME",
    "USER",
    "USERNAME",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SHELL",
    "ComSpec",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "NODE_ENV",
    "npm_config_cache",
    "CI",
    "COLORTERM",
    "TERM_PROGRAM",
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) {
      continue;
    }
    const upper = k.toUpperCase();
    if (
      /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|AUTH/i.test(k) &&
      !keep.has(k)
    ) {
      continue;
    }
    if (keep.has(k) || upper.startsWith("npm_") || upper.startsWith("VSCODE_")) {
      out[k] = v;
    }
  }
  // Ensure PATH exists
  if (!out.PATH && base.PATH) {
    out.PATH = base.PATH;
  }
  out.CODEPARTNER_SANDBOX = "1";
  return out;
}

function findNetworkReason(command: string): string | undefined {
  for (const { re, reason } of NETWORK_OR_INSTALL) {
    if (re.test(command)) {
      return reason;
    }
  }
  return undefined;
}

/**
 * Assess and optionally rewrite a shell command under the given sandbox mode.
 * @param yolo from approvalPolicy === "yolo"
 */
export function assessSandboxedCommand(
  command: string,
  mode: SandboxMode,
  opts: { yolo?: boolean; workspaceRoot?: string } = {}
): SandboxAssessment {
  const notes: string[] = [];
  const cmd = (command || "").trim();
  if (!cmd) {
    return { allow: false, reason: "empty command", effectiveCommand: cmd, notes };
  }

  if (mode === "off") {
    return { allow: true, effectiveCommand: cmd, notes: ["sandbox off"] };
  }

  // Always apply commandSafety in soft/strict
  const safety: CommandSafetyResult = assessCommand(cmd, !!opts.yolo);
  if (safety.level === "block") {
    return {
      allow: false,
      reason: safety.reason || "blocked by command safety",
      effectiveCommand: cmd,
      notes: ["commandSafety block"],
    };
  }
  if (safety.level === "warn") {
    notes.push(`commandSafety warn: ${safety.reason}`);
  }

  const net = findNetworkReason(cmd);
  if (mode === "strict" && net && !opts.yolo) {
    // Strict: block network/install patterns unless yolo (user accepted full risk)
    return {
      allow: false,
      reason: `strict sandbox blocked (${net}). Set codepartner.sandboxMode to "soft" or approvalPolicy to "yolo" if intentional.`,
      effectiveCommand: cmd,
      notes,
    };
  }
  if (net) {
    notes.push(net);
  }

  let effective = cmd;
  const env = buildSandboxEnv();

  // Optional Linux bubblewrap isolation in strict mode
  if (mode === "strict" && opts.workspaceRoot && detectBubblewrap()) {
    const root = opts.workspaceRoot;
    const home = os.homedir();
    const tmp = os.tmpdir();
    // Read-only system, read-write workspace + tmp + home/.codepartner
    const cpHome = path.join(home, ".codepartner");
    const wrapped = [
      "bwrap",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--bind", tmp, tmp,
      "--bind", root, root,
      "--bind", cpHome, cpHome,
      "--chdir", root,
      "--die-with-parent",
      "--",
      "bash",
      "-lc",
      JSON.stringify(cmd).slice(1, -1), // escape for -c is hard; use env bash -c with careful quoting
    ];
    // Safer: pass command via bash -c with single-quoted escaped payload
    const escaped = cmd.replace(/'/g, `'\\''`);
    effective = `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind ${shellQuote(tmp)} ${shellQuote(tmp)} --bind ${shellQuote(root)} ${shellQuote(root)} --bind ${shellQuote(cpHome)} ${shellQuote(cpHome)} --chdir ${shellQuote(root)} --die-with-parent -- bash -lc '${escaped}'`;
    notes.push("bubblewrap isolation enabled");
  } else if (mode === "strict") {
    notes.push(
      detectBubblewrap()
        ? "bubblewrap available but no workspace root"
        : "strict mode without bubblewrap (pattern + env only)"
    );
  }

  return {
    allow: true,
    effectiveCommand: effective,
    env,
    notes,
  };
}

function shellQuote(p: string): string {
  if (!/[\s"$`\\]/.test(p)) {
    return p;
  }
  return `"${p.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function getSandboxMode(raw: string | undefined): SandboxMode {
  if (raw === "strict" || raw === "soft" || raw === "off") {
    return raw;
  }
  return "soft"; // default: soft protection
}
