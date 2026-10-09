/**
 * Local skills under ~/.codepartner/skills (no backend).
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export class SkillManager {
  constructor(private workspaceRoot: string) { }

  private getSkillsDir(): string {
    const homeDir = os.homedir();
    const dir = path.join(homeDir, ".codepartner", "skills");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  public createSkill(name: string, description: string, instructions: string): string {
    const fileName = `${name.replace(/\s+/g, "_").toLowerCase()}.md`;
    const fullPath = path.join(this.getSkillsDir(), fileName);
    const content = `---\nDescription: ${description}\n---\n\n${instructions}`;
    fs.writeFileSync(fullPath, content, "utf8");
    return `Skill "${name}" saved to ${fileName}`;
  }

  public useSkill(name: string): string {
    const fileName = `${name.replace(/\s+/g, "_").toLowerCase()}.md`;
    const fullPath = path.join(this.getSkillsDir(), fileName);
    if (!fs.existsSync(fullPath)) {
      return `Error: Skill "${name}" not found.`;
    }
    const content = fs.readFileSync(fullPath, "utf8");
    return `\n--- Skill: ${name} ---\n${content}\n\n`;
  }

  public listSkills(): any[] {
    const dir = this.getSkillsDir();
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const content = fs.readFileSync(path.join(dir, f), "utf8");
        const descMatch = content.match(/Description: (.*)/);
        return {
          name: f.replace(".md", ""),
          description: descMatch ? descMatch[1] : "No description",
        };
      });
  }
}
