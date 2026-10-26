import fs from "node:fs";
import path from "node:path";

import { relativePosix } from "./paths.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".tyxtest", "tyxtest"]);

export function listSourceFiles(cwd: string, limit = 400): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(relativePosix(cwd, full));
      }
    }
  };
  walk(cwd);
  return found.sort();
}

export function readFileBundle(cwd: string, files: string[], maxChars: number): string {
  let used = 0;
  const chunks: string[] = [];
  for (const file of files) {
    const absolute = path.join(cwd, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    let text = fs.readFileSync(absolute, "utf8");
    const remaining = maxChars - used;
    if (remaining <= 0) {
      chunks.push(`===== ${file} =====\n[truncated: budget exhausted]\n`);
      break;
    }
    if (text.length > remaining) text = `${text.slice(0, remaining)}\n[truncated]\n`;
    chunks.push(`===== ${file} =====\n${text.endsWith("\n") ? text : `${text}\n`}`);
    used += text.length;
  }
  return chunks.join("\n");
}

export function routerFiles(files: string[]): string[] {
  return files.filter((file) => {
    const normalized = file.replace(/\\/g, "/");
    return (
      /(^|\/)app\/.*\/(page|layout|route|template)\.(tsx|ts|jsx|js)$/.test(normalized) ||
      /(^|\/)pages\/.+\.(tsx|ts|jsx|js)$/.test(normalized) ||
      /(^|\/)src\/routes\/.+\.(tsx|ts|jsx|js)$/.test(normalized) ||
      /(^|\/)router\.(tsx|ts|jsx|js)$/.test(normalized)
    );
  });
}
