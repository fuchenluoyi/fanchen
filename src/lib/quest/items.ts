/**
 * 道具注册表与珍贵等级查询。
 *
 * 白名单原则（§3.3 硬约束 1）：奖励与目标只能引用这里登记过的道具 id，
 * 模型不能凭空发明道具 —— 这是「输出空间有限、可枚举、可校验」的落点。
 *
 * 本模块是纯数据 + 纯查询函数（NFR-009）。
 */
import {
  TIER_LABEL,
  TIER_LIST,
  TIER_ORDER,
  TIER_VALUE_RANGE,
} from './constants.ts';
import type { ItemDef, ItemStack, ItemTier } from './types.ts';

/** 初始道具表：17 件，五档俱全（策划数据，之后可外置成 JSON 而不改逻辑） */
export const ITEM_LIST: readonly ItemDef[] = [
  // 凡品
  {
    id: 'rations',
    name: '干粮',
    tier: 'common',
    value: 2,
    kind: 'material',
    stackable: true,
    description: '粗面饼子，顶饿不管饱。',
    tags: ['吃食', '补给'],
  },
  {
    id: 'water',
    name: '清水',
    tier: 'common',
    value: 1,
    kind: 'material',
    stackable: true,
    description: '竹筒装的井水。',
    tags: ['吃食', '补给'],
  },
  {
    id: 'cloth',
    name: '粗麻布',
    tier: 'common',
    value: 3,
    kind: 'material',
    stackable: true,
    description: '包扎、缠柄都用得上。',
    tags: ['材料'],
  },
  {
    id: 'bamboo-tally',
    name: '竹签',
    tier: 'common',
    value: 1,
    kind: 'token',
    stackable: true,
    description: '写个名字，当凭据使。',
    tags: ['凭据'],
  },

  // 良品
  {
    id: 'jinchuang-gao',
    name: '金疮药',
    tier: 'fine',
    value: 12,
    kind: 'medicine',
    stackable: true,
    description: '刀伤出血，敷上便能收口。',
    tags: ['药', '外伤'],
  },
  {
    id: 'fire-starter',
    name: '火折子',
    tier: 'fine',
    value: 8,
    kind: 'tool',
    stackable: true,
    description: '吹一口就着，走夜路少不了。',
    tags: ['器具'],
  },
  {
    id: 'bamboo-whistle',
    name: '竹哨',
    tier: 'fine',
    value: 15,
    kind: 'tool',
    stackable: false,
    description: '吹起来尖利，山里头传得远。',
    tags: ['器具', '传信'],
  },
  {
    id: 'gancao',
    name: '甘草',
    tier: 'fine',
    value: 10,
    kind: 'material',
    stackable: true,
    description: '寻常药材，调和诸药。',
    tags: ['药', '材料'],
  },

  // 上品
  {
    id: 'sanqi',
    name: '三七',
    tier: 'rare',
    value: 45,
    kind: 'material',
    stackable: true,
    description: '止血化瘀的上品药材，山里难寻。',
    tags: ['药', '材料', '寻药'],
  },
  {
    id: 'danggui',
    name: '当归',
    tier: 'rare',
    value: 30,
    kind: 'material',
    stackable: true,
    description: '补血调经，药庐常备。',
    tags: ['药', '材料'],
  },
  {
    id: 'xingshen-tea',
    name: '醒神茶',
    tier: 'rare',
    value: 25,
    kind: 'medicine',
    stackable: true,
    description: '一夜不睡也撑得住，过后要还债。',
    tags: ['药', '提神'],
  },
  {
    id: 'coldiron-needle',
    name: '寒铁针',
    tier: 'rare',
    value: 60,
    kind: 'tool',
    stackable: true,
    description: '针身泛青，入穴极准。',
    tags: ['器具', '医术'],
  },

  // 珍品
  {
    id: 'century-lingzhi',
    name: '百年灵芝',
    tier: 'epic',
    value: 180,
    kind: 'medicine',
    stackable: true,
    description: '生在背阴老树上，可遇不可求。',
    tags: ['药', '珍稀'],
  },
  {
    id: 'coldiron-dagger',
    name: '寒铁匕首',
    tier: 'epic',
    value: 150,
    kind: 'treasure',
    stackable: false,
    description: '贴身之物，轻易不外借。',
    tags: ['兵器', '信物'],
  },
  {
    id: 'snow-silkworm',
    name: '雪山冰蚕',
    tier: 'epic',
    value: 220,
    kind: 'material',
    stackable: false,
    description: '通体透亮，触手生寒。',
    tags: ['材料', '珍稀'],
  },

  // 绝品
  {
    id: 'jiuzhuan-dan',
    name: '九转还魂丹',
    tier: 'legendary',
    value: 480,
    kind: 'medicine',
    stackable: true,
    description: '传说中能吊住一口气的东西。',
    tags: ['药', '传说'],
  },
  {
    id: 'xuanyu-token',
    name: '玄玉令',
    tier: 'legendary',
    value: 620,
    kind: 'token',
    stackable: false,
    description: '不知是哪一家的信物，见令如见人。',
    tags: ['凭据', '传说'],
  },
];

const ITEM_INDEX: ReadonlyMap<string, ItemDef> = new Map(ITEM_LIST.map((item) => [item.id, item]));

/** 取一件道具定义；未登记则返回 null（调用方负责转成 unknown_item） */
export function getItem(itemId: string): ItemDef | null {
  return ITEM_INDEX.get(itemId) ?? null;
}

export function isKnownItem(itemId: string): boolean {
  return ITEM_INDEX.has(itemId);
}

export function itemName(itemId: string): string {
  return getItem(itemId)?.name ?? itemId;
}

export function itemTier(itemId: string): ItemTier | null {
  return getItem(itemId)?.tier ?? null;
}

/** 单位参考价值；未登记的道具没有价值（返回 0，不猜） */
export function itemValue(itemId: string): number {
  return getItem(itemId)?.value ?? 0;
}

/** 一组道具的总价值 */
export function stacksValue(stacks: readonly ItemStack[]): number {
  let sum = 0;
  for (const stack of stacks) sum += itemValue(stack.itemId) * Math.max(0, stack.count);
  return sum;
}

export function itemsByTier(tier: ItemTier): ItemDef[] {
  return ITEM_LIST.filter((item) => item.tier === tier);
}

export function itemsByTag(tag: string): ItemDef[] {
  return ITEM_LIST.filter((item) => item.tags.includes(tag));
}

/** 按名称/标签/描述模糊检索 —— 模型提到「三七」但不确定 id 时，用它给候选列表消除歧义（§2.3） */
export function searchItems(keyword: string, limit = 8): ItemDef[] {
  const needle = String(keyword ?? '').trim().toLowerCase();
  if (!needle) return [];
  const scored: Array<{ item: ItemDef; score: number }> = [];
  for (const item of ITEM_LIST) {
    let score = 0;
    if (item.name === needle) score += 100;
    else if (item.name.includes(needle)) score += 60;
    if (item.id.includes(needle)) score += 40;
    if (item.tags.some((tag) => tag.includes(needle))) score += 20;
    if (item.description.includes(needle)) score += 10;
    if (score > 0) scored.push({ item, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.item);
}

export function tierLabel(tier: ItemTier): string {
  return TIER_LABEL[tier];
}

export function tierOrder(tier: ItemTier): number {
  return TIER_ORDER[tier];
}

/**
 * 数据自检：等级与价值必须自洽。
 * 返回问题清单（空数组 = 干净）；单测会断言它为空。
 */
export function auditItemTable(items: readonly ItemDef[] = ITEM_LIST): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id) problems.push(`道具缺少 id：${item.name}`);
    if (seen.has(item.id)) problems.push(`道具 id 重复：${item.id}`);
    seen.add(item.id);
    if (!item.name) problems.push(`道具缺少名称：${item.id}`);
    if (!TIER_LIST.includes(item.tier)) problems.push(`未知等级：${item.id} → ${item.tier}`);
    const [min, max] = TIER_VALUE_RANGE[item.tier];
    if (!Number.isFinite(item.value) || item.value < min || item.value > max) {
      problems.push(
        `${item.name}（${TIER_LABEL[item.tier]}）价值 ${item.value} 不在 ${min}-${max} 区间内`,
      );
    }
  }
  return problems;
}
