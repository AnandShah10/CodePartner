/**
 * Local soft sandbox — block or warn on obviously destructive shell patterns.
 * Not a real OS sandbox; reduces accidental catastrophic commands.
 */

export type CommandSafetyLevel = "allow" | "block" | "warn";

export interface CommandSafetyResult {
  level: CommandSafetyLevel;
  reason?: string;
}

/** Patterns that should never run without explicit yolo (or ever). */
const BLOCK_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/i, reason: "rm of filesystem root" },
  { re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/\s*/i, reason: "recursive force remove of /" },
  { re: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/\s*/i, reason: "recursive force remove of /" },
  { re: /\bmkfs\b/i, reason: "mkfs formats disks" },
  { re: /\bdd\s+if=.+of=\/dev\//i, reason: "dd writing to a device" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: "fork bomb" },
  { re: /\b(shutdown|reboot|poweroff)\b/i, reason: "system power command" },
  { re: /\bcurl\b.+\|\s*(ba)?sh\b/i, reason: "pipe remote script to shell" },
  { re: /\bwget\b.+\|\s*(ba)?sh\b/i, reason: "pipe remote script to shell" },
  { re: /\bgit\s+push\s+.*--force\s+.*:(\s|$)/i, reason: "force-push deleting remote ref" },
];

const WARN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/i, reason: "recursive force delete" },
  { re: /\bgit\s+push\s+[^\n]*--force\b/i, reason: "git push --force" },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: "git reset --hard" },
  { re: /\bDROP\s+(TABLE|DATABASE)\b/i, reason: "SQL DROP" },
  { re: /\bchmod\s+-R\s+777\b/i, reason: "chmod -R 777" },
];

/**
 * @param yolo when true, only BLOCK_PATTERNS still block (absolute dangers).
 */
export function assessCommand(command: string, yolo = false): CommandSafetyResult {
  const cmd = (command || "").trim();
  if (!cmd) {
    return { level: "allow" };
  }
  for (const { re, reason } of BLOCK_PATTERNS) {
    if (re.test(cmd)) {
      return { level: "block", reason };
    }
  }
  if (!yolo) {
    for (const { re, reason } of WARN_PATTERNS) {
      if (re.test(cmd)) {
        return { level: "warn", reason };
      }
    }
  }
  return { level: "allow" };
}
