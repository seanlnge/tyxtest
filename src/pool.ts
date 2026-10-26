export async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (true) {
        const current = cursor;
        cursor += 1;
        if (current >= items.length) return;
        results[current] = await worker(items[current] as T, current);
      }
    }),
  );
  return results;
}
