import { createHash } from "node:crypto";

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
