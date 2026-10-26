import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface Prompter {
  ask(question: string): Promise<string>;
  warn(message: string): void;
  log(message: string): void;
  close?(): void;
}

export function readlinePrompter(): Prompter {
  const rl = readline.createInterface({ input, output });
  return {
    async ask(question: string): Promise<string> {
      const suffix = question.endsWith(" ") ? question : `${question} `;
      const answer = await rl.question(suffix);
      return answer.trim();
    },
    warn(message: string): void {
      console.error(`warning: ${message}`);
    },
    log(message: string): void {
      console.log(message);
    },
    close(): void {
      rl.close();
    },
  };
}
