/**
 * Local computer-use style browser control (Puppeteer, no CodePartner backend).
 * page.evaluate bodies are passed as strings so tsc (lib: ES2022, no DOM) stays happy.
 */

import * as path from "path";
import * as fs from "fs";
import { truncateToTokenBudget } from "./tokenEstimate";

export interface BrowserActionArgs {
  action: string;
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
  direction?: string;
  key?: string;
  script?: string;
  limit?: number;
}

/** Runs inside the browser — kept as source text for page.evaluate. */
const OBSERVE_FN = `function observeInPage(maxEls) {
  var url = location.href;
  var title = document.title;
  var interactive = Array.prototype.slice.call(
    document.querySelectorAll(
      "a[href], button, input, select, textarea, [role='button'], [role='link'], [onclick], [contenteditable='true']"
    ),
    0,
    maxEls
  );

  function cssPath(el) {
    if (el.id) return "#" + el.id;
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 4) {
      var part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift("#" + cur.id);
        break;
      }
      var parent = cur.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === cur.tagName;
        });
        if (siblings.length > 1) {
          var idx = Array.prototype.indexOf.call(siblings, cur) + 1;
          part += ":nth-of-type(" + idx + ")";
        }
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ");
  }

  var elements = interactive.map(function (el, i) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute("role") || "";
    var type = el.getAttribute("type") || "";
    var name = el.getAttribute("name") || "";
    var placeholder = el.getAttribute("placeholder") || "";
    var aria = el.getAttribute("aria-label") || "";
    var text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    var href = el.href || el.getAttribute("href") || "";
    var value = el.value || "";
    var disabled = !!el.disabled;
    return {
      index: i,
      tag: tag,
      role: role,
      type: type,
      name: name,
      placeholder: placeholder,
      aria: aria,
      text: text,
      href: String(href).slice(0, 120),
      value: String(value).slice(0, 60),
      disabled: disabled,
      selector: cssPath(el),
    };
  });

  var bodyText = (document.body && document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 2000);
  return { url: url, title: title, elements: elements, bodyText: bodyText };
}`;

const SELECT_BY_LABEL_FN = `function selectByLabel(sel, label) {
  var el = document.querySelector(sel);
  if (!el) return;
  var opts = el.options || [];
  for (var i = 0; i < opts.length; i++) {
    var o = opts[i];
    if (o.text.trim() === label || o.value === label) {
      el.value = o.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
  }
}`;

export class BrowserManager {
  private browser: any;
  private currentPage: any;

  constructor(private workspaceRoot: string) { }

  private findChromePath(): string | null {
    const platform = process.platform;
    const candidates: string[] = [];
    if (platform === "win32") {
      candidates.push(
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe"
      );
    } else if (platform === "darwin") {
      candidates.push(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
      );
    } else {
      candidates.push(
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium"
      );
    }
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return null;
  }

  private async ensurePage(action: string): Promise<{ page: any; error?: string }> {
    const chromePath = this.findChromePath();
    if (!chromePath) {
      return {
        page: null,
        error: "Error: No Chrome/Chromium browser found. Install Chrome or set the path manually.",
      };
    }
     
    const puppeteer = require("puppeteer-core");
    if (!this.browser) {
      try {
        this.browser = await puppeteer.launch({
          executablePath: chromePath,
          headless: "new",
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,800"],
        });
      } catch {
        try {
          this.browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
          });
        } catch (e: any) {
          return { page: null, error: `Browser launch error: ${e.message}` };
        }
      }
    }
    if (!this.currentPage || action === "navigate") {
      if (this.currentPage) {
        await this.currentPage.close().catch(() => { /* ignore */ });
      }
      this.currentPage = await this.browser.newPage();
      await this.currentPage.setViewport({ width: 1280, height: 800 }).catch(() => { /* ignore */ });
    }
    return { page: this.currentPage };
  }

  private async observePage(page: any, limit = 40): Promise<string> {
    const n = Math.max(1, Math.min(100, limit | 0));
    const snap = await page.evaluate(`(${OBSERVE_FN})(${n})`);
    const lines: string[] = [
      "## Observe",
      `URL: ${snap.url}`,
      `Title: ${snap.title}`,
      `Interactive elements (${snap.elements.length}):`,
    ];
    for (const el of snap.elements) {
      const label =
        el.aria || el.text || el.placeholder || el.name || el.href || el.value || "(no label)";
      lines.push(
        `  [${el.index}] <${el.tag}${el.type ? ` type=${el.type}` : ""}${el.role ? ` role=${el.role}` : ""}> "${label}" selector=\`${el.selector}\`${el.disabled ? " DISABLED" : ""}`
      );
    }
    lines.push(`Body text (truncated):\n${snap.bodyText}`);
    lines.push(
      "\nNext: pick a selector and call browser_control (click/type/select/press/scroll), then observe or screenshot again."
    );
    return lines.join("\n");
  }

  public async execute(
    action: string,
    url?: string,
    selector?: string,
    text?: string,
    extra?: Partial<BrowserActionArgs>
  ): Promise<string> {
    if (action === "close") {
      try {
        if (this.currentPage) {
          await this.currentPage.close().catch(() => { /* ignore */ });
          this.currentPage = undefined;
        }
        if (this.browser) {
          await this.browser.close().catch(() => { /* ignore */ });
          this.browser = undefined;
        }
        return "Browser closed.";
      } catch (e: any) {
        return `Browser close error: ${e.message}`;
      }
    }

    const ensured = await this.ensurePage(action);
    if (ensured.error || !ensured.page) {
      return ensured.error || "Error: no page";
    }
    const page = ensured.page;

    try {
      switch (action) {
        case "navigate": {
          if (!url) {
            return "Error: URL required for navigate.";
          }
          await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
          const title = await page.title();
          const obs = await this.observePage(page, extra?.limit || 30);
          return `Navigated to ${url}. Title: ${title}\n\n${obs}`;
        }
        case "observe": {
          if (url) {
            await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
          }
          return await this.observePage(page, extra?.limit || 40);
        }
        case "screenshot": {
          if (url) {
            await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
          }
          const id = Date.now().toString();
          const artifactDir = path.join(this.workspaceRoot, ".codepartner", "artifacts");
          if (!fs.existsSync(artifactDir)) {
            fs.mkdirSync(artifactDir, { recursive: true });
          }
          const fileName = `screenshot_${id}.png`;
          const screenshotPath = path.join(artifactDir, fileName);
          await page.screenshot({ path: screenshotPath, fullPage: false });
          let b64note = "";
          try {
            const buf = fs.readFileSync(screenshotPath);
            if (buf.length < 120000) {
              b64note = `\nBase64 PNG (short): data:image/png;base64,${buf.toString("base64").slice(0, 200)}… (full file on disk)`;
            }
          } catch {
            /* ignore */
          }
          const artifact = {
            id,
            title: `Screenshot: ${url || "current page"}`,
            type: "screenshot",
            content: fileName,
            filePath: screenshotPath,
            timestamp: Date.now(),
          };
          const obs = await this.observePage(page, 15);
          return `${JSON.stringify(artifact)}\nSaved: ${screenshotPath}${b64note}\n\n${obs}`;
        }
        case "click": {
          if (!selector) {
            return "Error: selector required for click.";
          }
          await page.waitForSelector(selector, { timeout: 8000 });
          await page.click(selector);
          await page.waitForNetworkIdle({ timeout: 3000 }).catch(() => { /* ignore */ });
          return `Clicked \`${selector}\`.\n\n${await this.observePage(page, 25)}`;
        }
        case "type": {
          if (!selector || text === undefined) {
            return "Error: selector and text required for type.";
          }
          await page.waitForSelector(selector, { timeout: 8000 });
          await page.click(selector, { clickCount: 3 }).catch(() => page.click(selector));
          await page.type(selector, text, { delay: 15 });
          return `Typed into \`${selector}\`: "${String(text).slice(0, 200)}"\n\n${await this.observePage(page, 15)}`;
        }
        case "hover": {
          if (!selector) {
            return "Error: selector required for hover.";
          }
          await page.waitForSelector(selector, { timeout: 8000 });
          await page.hover(selector);
          return `Hovered \`${selector}\`.\n\n${await this.observePage(page, 15)}`;
        }
        case "select": {
          if (!selector) {
            return "Error: selector required for select.";
          }
          const val = extra?.value ?? text;
          if (val === undefined) {
            return "Error: value/text required for select (option value or label).";
          }
          await page.waitForSelector(selector, { timeout: 8000 });
          try {
            await page.select(selector, val);
          } catch {
            await page.evaluate(
              `(${SELECT_BY_LABEL_FN})(${JSON.stringify(selector)}, ${JSON.stringify(val)})`
            );
          }
          return `Selected "${val}" on \`${selector}\`.\n\n${await this.observePage(page, 15)}`;
        }
        case "scroll": {
          const dir = (extra?.direction || text || "down").toLowerCase();
          if (dir === "top") {
            await page.evaluate("window.scrollTo(0, 0)");
          } else if (dir === "bottom") {
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
          } else {
            const delta = dir === "up" ? -600 : 600;
            await page.evaluate(`window.scrollBy(0, ${delta})`);
          }
          return `Scrolled ${dir}.\n\n${await this.observePage(page, 20)}`;
        }
        case "press": {
          const key = extra?.key || text || "Enter";
          if (selector) {
            await page.waitForSelector(selector, { timeout: 5000 });
            await page.focus(selector);
          }
          await page.keyboard.press(key);
          await page.waitForNetworkIdle({ timeout: 2000 }).catch(() => { /* ignore */ });
          return `Pressed key "${key}".\n\n${await this.observePage(page, 20)}`;
        }
        case "wait_for": {
          if (!selector) {
            return "Error: selector required for wait_for.";
          }
          await page.waitForSelector(selector, { timeout: 15000 });
          return `Element \`${selector}\` is present.\n\n${await this.observePage(page, 15)}`;
        }
        case "evaluate": {
          const script = extra?.script || text;
          if (!script) {
            return "Error: script/text required for evaluate.";
          }
          const result = await page.evaluate(`(function(){ return (${script}); })()`);
          const rendered =
            typeof result === "string" ? result : JSON.stringify(result, null, 0);
          const { text: capped, truncated } = truncateToTokenBudget(String(rendered ?? ""), 800);
          return `Evaluate result${truncated ? " (truncated)" : ""}:\n${capped}`;
        }
        default:
          return `Unknown browser action: ${action}. Use navigate|observe|screenshot|click|type|hover|select|scroll|press|wait_for|evaluate|close.`;
      }
    } catch (e: any) {
      return `Browser error: ${e.message}`;
    }
  }

  public async dispose(): Promise<void> {
    await this.execute("close");
  }
}
