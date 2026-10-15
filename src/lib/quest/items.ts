/**
 * 道具注册表与珍贵等级查询。
 *
 * 白名单原则（§3.3 硬约束 1）：奖励与目标只能引用这里登记过的道具 id，
 * 模型不能凭空发明道具 —— 这是「输出空间有限、可枚举、可校验」的落点。
 *
 * 每件道具有两套标签：
 *   tags —— 泛化类目（提示词检索、模型消歧用）
 *   uses —— **用途标签**（比 tags 细一档）：NPC 的「她在意的用途」靠它匹配，
 *           从而推出主观估值（只进叙事与展示，绝不参与裁决）
 *
 * 本模块是纯数据 + 纯查询函数（NFR-009）。
 */
import {
  ITEM_USES,
  TIER_LABEL,
  TIER_LIST,
  TIER_ORDER,
  TIER_VALUE_RANGE,
} from './constants.ts';
import type { ItemDef, ItemStack, ItemTier } from './types.ts';

/** 道具表：30 件，五档每档至少 5 件（策划数据，之后可外置成 JSON 而不改逻辑） */
export const ITEM_LIST: readonly ItemDef[] = [
  /* ------------------------------ 凡品 ------------------------------ */
  {
    id: 'rations',
    name: '干粮',
    tier: 'common',
    value: 2,
    kind: 'material',
    stackable: true,
    description: '粗面饼子，顶饿不管饱。',
    tags: ['吃食', '补给'],
    uses: ['吃食'],
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
    uses: ['吃食'],
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
    uses: ['材料'],
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
    uses: ['凭据'],
  },
  {
    id: 'grass-rope',
    name: '草绳',
    tier: 'common',
    value: 1,
    kind: 'material',
    stackable: true,
    description: '搓得粗糙，捆个柴火还成。',
    tags: ['材料'],
    uses: ['材料', '器具'],
  },
  {
    id: 'coarse-salt',
    name: '粗盐',
    tier: 'common',
    value: 2,
    kind: 'material',
    stackable: true,
    description: '腌菜入药都用得上，就是涩口。',
    tags: ['吃食', '材料'],
    uses: ['吃食', '调和'],
  },
  {
    id: 'bamboo-basket',
    name: '竹篓',
    tier: 'common',
    value: 4,
    kind: 'tool',
    stackable: true,
    description: '背在肩上，装得下三五斤草药。',
    tags: ['器具'],
    uses: ['器具', '材料'],
  },

  /* ------------------------------ 良品 ------------------------------ */
  {
    id: 'jinchuang-gao',
    name: '金疮药',
    tier: 'fine',
    value: 12,
    kind: 'medicine',
    stackable: true,
    description: '刀伤出血，敷上便能收口。',
    tags: ['药', '外伤'],
    uses: ['疗伤'],
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
    uses: ['器具'],
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
    uses: ['传信', '器具'],
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
    uses: ['调和', '材料'],
  },
  {
    id: 'mugwort',
    name: '艾草',
    tier: 'fine',
    value: 7,
    kind: 'material',
    stackable: true,
    description: '陈艾熏灸，止血散寒。',
    tags: ['药', '材料'],
    uses: ['疗伤', '材料'],
  },
  {
    id: 'huoxue-san',
    name: '活血散',
    tier: 'fine',
    value: 14,
    kind: 'medicine',
    stackable: true,
    description: '跌打淤青，冲服见效。',
    tags: ['药', '外伤'],
    uses: ['疗伤', '补血'],
  },
  {
    id: 'coin-string',
    name: '铜钱串',
    tier: 'fine',
    value: 6,
    kind: 'token',
    stackable: true,
    description: '一贯足钱，走哪儿都认。',
    tags: ['凭据'],
    uses: ['凭据'],
  },

  /* ------------------------------ 上品 ------------------------------ */
  {
    id: 'sanqi',
    name: '三七',
    tier: 'rare',
    value: 45,
    kind: 'material',
    stackable: true,
    description: '止血化瘀的上品药材，山里难寻。',
    tags: ['药', '材料', '寻药'],
    uses: ['疗伤', '材料'],
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
    uses: ['补血', '材料'],
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
    uses: ['提神'],
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
    uses: ['器具'],
  },
  {
    id: 'calming-incense',
    name: '静心香',
    tier: 'rare',
    value: 35,
    kind: 'medicine',
    stackable: true,
    description: '点上一炷，心浮气躁也能按下去。',
    tags: ['药', '安神'],
    uses: ['调和', '提神'],
  },
  {
    id: 'lingzhi-spore',
    name: '灵芝孢子',
    tier: 'rare',
    value: 40,
    kind: 'material',
    stackable: true,
    description: '细如尘粉，久服养元。',
    tags: ['药', '材料'],
    uses: ['滋补', '材料'],
  },
  {
    id: 'jade-beads',
    name: '玉髓手串',
    tier: 'rare',
    value: 70,
    kind: 'treasure',
    stackable: false,
    description: '腕上一串，成色温润，是旧物。',
    tags: ['信物'],
    uses: ['信物'],
  },

  /* ------------------------------ 珍品 ------------------------------ */
  {
    id: 'century-lingzhi',
    name: '百年灵芝',
    tier: 'epic',
    value: 180,
    kind: 'medicine',
    stackable: true,
    description: '生在背阴老树上，可遇不可求。',
    tags: ['药', '珍稀'],
    uses: ['滋补', '疗伤'],
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
    uses: ['兵器', '信物'],
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
    uses: ['材料', '疗伤'],
  },
  {
    id: 'snow-lotus',
    name: '雪莲',
    tier: 'epic',
    value: 120,
    kind: 'medicine',
    stackable: true,
    description: '雪线上开的花，续命的东西。',
    tags: ['药', '珍稀'],
    uses: ['滋补', '疗伤'],
  },
  {
    id: 'darkiron-bracer',
    name: '玄铁护腕',
    tier: 'epic',
    value: 95,
    kind: 'treasure',
    stackable: false,
    description: '沉手，挡过一刀，边上有缺口。',
    tags: ['兵器', '器具'],
    uses: ['兵器', '器具'],
  },
  {
    id: 'ambergris',
    name: '龙涎香',
    tier: 'epic',
    value: 260,
    kind: 'medicine',
    stackable: false,
    description: '一小块，闻之通窍醒神，值一座宅子。',
    tags: ['药', '珍稀'],
    uses: ['滋补', '提神'],
  },

  /* ------------------------------ 绝品 ------------------------------ */
  {
    id: 'jiuzhuan-dan',
    name: '九转还魂丹',
    tier: 'legendary',
    value: 480,
    kind: 'medicine',
    stackable: true,
    description: '传说中能吊住一口气的东西。',
    tags: ['药', '传说'],
    uses: ['疗伤', '滋补'],
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
    uses: ['凭据', '信物'],
  },
  {
    id: 'taisui-essence',
    name: '太岁精',
    tier: 'legendary',
    value: 350,
    kind: 'material',
    stackable: false,
    description: '土里长出来的肉芝，服之轻身。',
    tags: ['药', '传说'],
    uses: ['滋补', '材料'],
  },
  {
    id: 'heavenly-silk',
    name: '天蚕丝',
    tier: 'legendary',
    value: 420,
    kind: 'material',
    stackable: true,
    description: '刀割不断，织进衣里冬暖夏凉。',
    tags: ['材料', '珍稀'],
    uses: ['材料', '信物'],
  },
  {
    id: 'ninexiao-zither',
    name: '九霄环佩',
    tier: 'legendary',
    value: 800,
    kind: 'treasure',
    stackable: false,
    description: '一张古琴，弦上还留着别人的指温。',
    tags: ['信物', '乐器'],
    uses: ['信物', '器具'],
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

/** 这件道具的用途标签（未登记返回空数组） */
export function itemUses(itemId: string): readonly string[] {
  return getItem(itemId)?.uses ?? [];
}

/** 这件道具是否带有某个用途（NPC 的「她在意的用途」靠它匹配） */
export function itemHasUse(itemId: string, use: string): boolean {
  return itemUses(itemId).includes(use);
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

export function itemsByUse(use: string): ItemDef[] {
  return ITEM_LIST.filter((item) => item.uses.includes(use));
}

/** 按名称/标签/用途/描述模糊检索 —— 模型提到「三七」但不确定 id 时给它候选（§2.3） */
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
    if (item.uses.some((use) => use.includes(needle))) score += 20;
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
 * 数据自检：等级、价值、用途三者必须自洽。
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
    if (!Array.isArray(item.uses) || item.uses.length === 0) {
      problems.push(`${item.name}（${item.id}）没有用途标签 uses`);
    } else {
      for (const use of item.uses) {
        if (!ITEM_USES.includes(use)) problems.push(`${item.name} 的用途标签不在词表内：${use}`);
      }
    }
  }
  return problems;
}
