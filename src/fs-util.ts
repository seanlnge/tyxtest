import fs from "node:fs";
import path from "node:path";

export function writeText(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}
