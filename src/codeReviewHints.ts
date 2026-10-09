/**
 * Lightweight static review + policy packs (no backend).
 */

export interface ReviewHint {
  severity: "info" | "warning";
  message: string;
  pack?: string;
}

export type ReviewPackId = "security" | "react" | "node" | "quality";

interface PatternRule {
  re: RegExp;
  severity: ReviewHint["severity"];
  message: string;
  pack: ReviewPackId;
  /** If set, only apply when path matches */
  pathRe?: RegExp;
}

const RULES: PatternRule[] = [
  // security
  { pack: "security", re: /\beval\s*\(/, severity: "warning", message: "Uses eval() — high injection risk." },
  { pack: "security", re: /\bnew\s+Function\s*\(/, severity: "warning", message: "Uses new Function() — similar risk to eval()." },
  { pack: "security", re: /\binnerHTML\s*=/, severity: "warning", message: "Assigns innerHTML — XSS risk if user-controlled." },
  { pack: "security", re: /dangerouslySetInnerHTML/, severity: "warning", message: "dangerouslySetInnerHTML — ensure sanitization." },
  { pack: "security", re: /document\.write\s*\(/, severity: "warning", message: "document.write — often unsafe with untrusted input." },
  { pack: "security", re: /child_process\.(exec|execSync)\s*\(\s*[`'"]\s*\$\{/, severity: "warning", message: "Shell command with interpolation — injection risk." },
  { pack: "security", re: /\bexecSync\s*\(\s*[`'"]/, severity: "info", message: "execSync with string — prefer execFile/spawn with args." },
  { pack: "security", re: /rejectUnauthorized\s*:\s*false/i, severity: "warning", message: "TLS verification disabled (rejectUnauthorized: false)." },
  { pack: "security", re: /password\s*=\s*['"][^'"]+['"]|api[_-]?key\s*=\s*['"][^'"]+['"]/i, severity: "warning", message: "Possible hard-coded credential." },
  { pack: "security", re: /\b(AWS|GITHUB|OPENAI|AZURE)[_-]?SECRET\b|\bsk-[a-zA-Z0-9]{20,}/, severity: "warning", message: "Possible secret token in source." },
  { pack: "security", re: /\bhttp:\/\/(?!localhost|127\.0\.0\.1)/i, severity: "info", message: "Plain HTTP URL — prefer HTTPS for remote endpoints." },
  { pack: "security", re: /\bdisableHostCheck\s*:\s*true|\bCORS\s*\*\s*/, severity: "info", message: "Permissive host/CORS setting — review for production." },

  // react
  { pack: "react", pathRe: /\.(tsx|jsx)$/, re: /\buseEffect\s*\(\s*\(\s*\)\s*=>\s*\{[^}]*fetch\b/, severity: "info", message: "fetch inside useEffect — check deps and cleanup/abort." },
  { pack: "react", pathRe: /\.(tsx|jsx)$/, re: /\bkey=\{\s*index\s*\}/, severity: "info", message: "React list key={index} — unstable if list reorders." },
  { pack: "react", pathRe: /\.(tsx|jsx)$/, re: /\btarget=["']_blank["'](?![^>]*rel=)/, severity: "warning", message: "target=_blank without rel=noopener — tabnabbing risk." },

  // node
  { pack: "node", pathRe: /\.(ts|js|mjs|cjs)$/, re: /\bprocess\.env\.\w+\s*\|\|\s*['"][^'"]+['"]/, severity: "info", message: "Env fallback to literal — ensure secrets aren't defaulted in source." },
  { pack: "node", pathRe: /\.(ts|js|mjs|cjs)$/, re: /\bfs\.(readFileSync|writeFileSync)\([^)]*\.\./, severity: "warning", message: "fs path may include .. — ensure containment." },
  { pack: "node", pathRe: /\.(ts|js|mjs|cjs)$/, re: /\bBuffer\.from\([^,]+,\s*['"]base64['"]\)/, severity: "info", message: "Base64 Buffer decode — validate input size/source." },

  // quality
  { pack: "quality", re: /\bTODO\b|\bFIXME\b|\bHACK\b/, severity: "info", message: "Contains TODO/FIXME/HACK marker." },
  { pack: "quality", re: /\bconsole\.(log|debug|info)\s*\(/, severity: "info", message: "console logging left in code — remove or gate for production." },
  { pack: "quality", re: /\bany\b/, severity: "info", message: "TypeScript `any` — prefer a tighter type.", pathRe: /\.tsx?$/ },
  { pack: "quality", re: /\b@ts-ignore\b|\b@ts-nocheck\b/, severity: "info", message: "TypeScript suppression comment." },
  { pack: "quality", re: /\bemitter\.on\([^)]+\)(?![\s\S]{0,200}\.off\b|\.removeListener\b)/, severity: "info", message: "Event listener — ensure removal to avoid leaks (heuristic)." },
];

function activePacks(relPath: string, enabled: ReviewPackId[]): Set<ReviewPackId> {
  const set = new Set(enabled);
  // Auto-enable react/node by path if "all" not used — caller passes packs
  if (/\.(tsx|jsx)$/.test(relPath)) {
    set.add("react");
  }
  if (/\.(ts|js|mjs|cjs)$/.test(relPath) && !/\.(tsx|jsx)$/.test(relPath)) {
    set.add("node");
  }
  return set;
}

/**
 * @param packs which policy packs to run (default: security + quality + path-based)
 */
export function reviewText(
  relPath: string,
  content: string,
  packs?: ReviewPackId[]
): ReviewHint[] {
  const hints: ReviewHint[] = [];
  if (!content) {
    return hints;
  }
  const lines = content.split(/\r?\n/);
  const enabled = activePacks(
    relPath,
    packs && packs.length ? packs : ["security", "quality", "react", "node"]
  );

  for (const rule of RULES) {
    if (!enabled.has(rule.pack)) {
      continue;
    }
    if (rule.pathRe && !rule.pathRe.test(relPath)) {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (rule.re.test(lines[i])) {
        hints.push({
          severity: rule.severity,
          message: `${relPath}:${i + 1}: ${rule.message}`,
          pack: rule.pack,
        });
        break;
      }
    }
  }

  return hints.slice(0, 12);
}

export function formatReviewHints(hints: ReviewHint[]): string {
  if (!hints.length) {
    return "";
  }
  return (
    "\n[Review policy]\n" +
    hints.map((h) => `- (${h.severity}${h.pack ? `/${h.pack}` : ""}) ${h.message}`).join("\n") +
    "\n"
  );
}
