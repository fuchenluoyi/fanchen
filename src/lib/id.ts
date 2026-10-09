let counter = 0;

/** 生成短且可读的唯一 id（不依赖 crypto.randomUUID，方便在 Node 与浏览器通用）。 */
export function createId(prefix = 'id'): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}${rand}`;
}
