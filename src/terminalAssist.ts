/**
 * Decision logic for the terminal inline assistant — offering AI help
 * when a terminal command fails. Kept separate from the VS Code
 * event-wiring (in extension.ts) so it's testable without a real
 * terminal or shell integration.
 */

/** True if this exit code represents a failure worth offering help for. Excludes success and user-initiated interruption (Ctrl+C, SIGTERM), which aren't really "failures" to debug. */
export function isFailureWorthAssisting(exitCode: number | undefined): boolean {
  if (exitCode === undefined || exitCode === 0) {
    return false;
  }
  if (exitCode === 130) {
    return false; // SIGINT (Ctrl+C)
  }
  if (exitCode === 143) {
    return false; // SIGTERM
  }
  return true;
}

export interface AssistOfferSignature {
  terminalId: string;
  commandLine: string;
  exitCode: number;
  timestamp: number;
}

/**
 * Decides whether to show a new offer, or suppress it as a repeat of
 * the last one (e.g. the user re-ran the exact same failing command
 * moments ago and doesn't need a second popup for it).
 */
export function shouldOfferAssist(
  last: AssistOfferSignature | null,
  current: AssistOfferSignature,
  dedupeWindowMs = 15000
): boolean {
  if (!last) {
    return true;
  }
  const sameSignature =
    last.terminalId === current.terminalId &&
    last.commandLine === current.commandLine &&
    last.exitCode === current.exitCode;
  if (sameSignature && current.timestamp - last.timestamp < dedupeWindowMs) {
    return false;
  }
  return true;
}

/**
 * Builds the chat prompt sent when the user accepts an assist offer.
 * Keeps the END of long output (not the start) since error summaries
 * and stack traces are usually at the bottom of terminal output.
 */
export function buildAssistPrompt(commandLine: string, exitCode: number, output: string, maxOutputChars = 3000): string {
  const trimmed = output.trim();
  const truncated = trimmed.length > maxOutputChars
    ? `... (truncated, showing the end)\n${trimmed.slice(-maxOutputChars)}`
    : trimmed;
  return `This command failed:\n\n\`\`\`\n${commandLine}\n\`\`\`\n\nExit code: ${exitCode}\n\nOutput:\n\`\`\`\n${truncated || "(no output captured)"}\n\`\`\`\n\nCan you help me figure out what went wrong and how to fix it?`;
}