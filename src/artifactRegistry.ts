/**
 * Local artifact store under ~/.codepartner/artifacts (no backend).
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export class ArtifactRegistry {
  private artifacts: Map<string, any> = new Map();
  private baseDir: string;

  constructor() {
    const homeDir = os.homedir();
    this.baseDir = path.join(homeDir, ".codepartner", "artifacts");
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public create(title: string, content: string, type: string) {
    const id = Date.now().toString();
    const fileName = `${id}_${title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.${type === "code" ? "txt" : type === "markdown" ? "md" : "log"}`;
    const filePath = path.join(this.baseDir, fileName);

    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, "utf8");

    const artifact = { id, title, type, content, filePath, timestamp: Date.now() };
    this.artifacts.set(id, artifact);
    return artifact;
  }

  public getAll() {
    return Array.from(this.artifacts.values());
  }
}
