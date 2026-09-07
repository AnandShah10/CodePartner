/**
 * Strips ANSI escape sequences from terminal output.
 *
 * VS Code's Terminal Shell Integration API's `TerminalShellExecution.read()`
 * returns raw terminal output, including ANSI escape codes (color codes,
 * cursor movement, etc.) — not useful, and actively confusing, inside an
 * LLM prompt. This covers the common sequence classes: CSI sequences
 * (colors, cursor control — the vast majority of real-world output),
 * OSC sequences (e.g. terminal title-setting, often terminated by BEL or
 * ST), and lone C0 control characters that sometimes slip through.
 */
export function stripAnsiCodes(text: string): string {
  if (!text) {return text;}
  return text
    // CSI sequences: ESC [ ... <final byte in 0x40-0x7E>
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    // OSC sequences: ESC ] ... (terminated by BEL or ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Other lone escape sequences (e.g. ESC followed by a single char)
    .replace(/\x1b[@-Z\\-_]/g, "")
    // Carriage returns used for in-place progress updates
    .replace(/\r(?!\n)/g, "");
}