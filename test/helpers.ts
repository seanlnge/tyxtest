import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Prompter } from "../src/commands/prompter.js";

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function scriptedPrompter(answers: string[]): Prompter & { warnings: string[]; logs: string[] } {
  const warnings: string[] = [];
  const logs: string[] = [];
  let index = 0;
  return {
    warnings,
    logs,
    async ask(question: string): Promise<string> {
      const answer = answers[index];
      index += 1;
      if (answer === undefined) throw new Error(`No scripted answer for: ${question}`);
      return answer;
    },
    warn(message: string): void {
      warnings.push(message);
    },
    log(message: string): void {
      logs.push(message);
    },
  };
}
