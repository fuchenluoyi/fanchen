/**
 * localStorage 封装（ADR-006）：版本化 key + 安全读写。
 * 任何异常（隐私模式、配额、脏数据）都不得让页面白屏（AC-10.2）。
 */

export const STORAGE_KEYS = {
  settings: 'fanchen.settings.v1',
  messages: 'fanchen.messages.v1',
  tasks: 'fanchen.tasks.v1',
  /** NPC 委托世界（NPC 背包 / 委托 / 事件流水），见 src/lib/quest/persist.ts */
  quest: 'fanchen.quest.v1',
} as const;

function getStore(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * @param key 存储键
 * @param fallback 读取失败时的返回值
 * @param guard 可选的结构校验
 */
export function loadJson<T>(key: string, fallback: T, guard?: (value: unknown) => boolean): T {
  const store = getStore();
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (guard && !guard(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): boolean {
  const store = getStore();
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKeys(keys: readonly string[]): void {
  const store = getStore();
  if (!store) return;
  for (const key of keys) {
    try {
      store.removeItem(key);
    } catch {
      /* 忽略 */
    }
  }
}

export function isArrayOfObjects(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => item !== null && typeof item === 'object');
}
