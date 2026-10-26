export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b/.test(message) || /rate limit/i.test(message);
}

export async function withRateLimitBackoff<T>(
  fn: () => Promise<T>,
  options?: { sleep?: (ms: number) => Promise<void>; maxAttempts?: number },
): Promise<T> {
  const sleep = options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options?.maxAttempts ?? 4;
  let last: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!isRateLimitError(error) || attempt === maxAttempts - 1) throw error;
      await sleep(50 * 2 ** attempt);
    }
  }
  throw last;
}
