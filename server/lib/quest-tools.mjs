/**
 * NPC 委托工具通道：给模型的工具定义 + 参数形状归一化。
 *
 * 职责边界（ADR-002 协议收敛 / ADR-013 只读真相处方）：
 *   服务端只做**形状**归一化 —— 模型给的参数可能缺字段、类型不对、把嵌套对象拍平了，
 *   这里把它收敛成干净的提案，再通过 SSE 交给前端。
 *   **规则**裁决（道具白名单、奖励档位、库存预留、幂等、守恒）全部在前端领域层
 *   （src/lib/quest/）完成：服务端不复制那套规则，也不持有世界状态。
 *
 * 因此本模块没有任何第三方依赖，也不 import TypeScript 领域层
 * （服务端要兼容 Node ≥ 20.11，而 .ts 类型剥离要求更高版本）。
 */

/* ============================== 常量 ============================== */

export const QUEST_TOOL_NAMES = ['propose_quest', 'submit_quest', 'decline_quest', 'note_impression'];

const OBJECTIVE_KINDS = ['deliver_item', 'has_item', 'talk_count', 'affinity_at_least'];
const REWARD_KINDS = ['item', 'affinity', 'ability', 'info', 'none'];
const ABILITY_IDS = ['jieyuan', 'qiecuo', 'michuan'];
const IMPRESSION_KINDS = ['pleased', 'neutral', 'offended'];

/* ============================== 工具定义 ============================== */

/**
 * 四个工具全是「提案」，没有一个是「执行」：
 * 模型说"我想给他这个""这话说到我心坎里了"，至于背包里有没有、发不发得出去、
 * 好感度加不加得上，由代码说了算（§2.3）。
 */
export const QUEST_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'propose_quest',
      description:
        '代表你自己向对方发布一条委托：说清你想要什么，并承诺一件你**自己背包里拿得出**的谢礼。' +
        '只在对方明确表示愿意帮忙、且你确实有东西可谢时调用。一次只挂一条委托，手上已有的委托未了结前不要再发。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '委托标题，不超过 20 字，如「寻一味三七」' },
          want: { type: 'string', description: '你想要什么，用你自己的口吻说，1-2 句' },
          tier: {
            type: 'integer',
            enum: [1, 2, 3],
            description: '事情轻重：1 小事（跑腿、带话）/ 2 正事（寻药、了结旧怨）/ 3 大事（性命攸关、身世之谜）',
          },
          objective_kind: {
            type: 'string',
            enum: OBJECTIVE_KINDS,
            description: '怎么算完成：交付道具 / 只需持有 / 陪你说够几轮话 / 好感达标',
          },
          objective_item_id: {
            type: 'string',
            description: 'objective_kind 为 deliver_item 或 has_item 时必填，必须是道具表里存在的 id',
          },
          objective_count: { type: 'integer', description: '道具件数，默认 1' },
          objective_rounds: { type: 'integer', description: 'objective_kind 为 talk_count 时的对话轮数' },
          objective_value: { type: 'integer', description: 'objective_kind 为 affinity_at_least 时的好感度阈值' },
          reward_kind: {
            type: 'string',
            enum: REWARD_KINDS,
            description: '谢礼形式：道具 / 好感度 / 功能解锁（结缘、切磋、秘传）/ 情报 / 对方不要谢礼',
          },
          reward_item_id: { type: 'string', description: 'reward_kind 为 item 时必填，只能从你自己背包里挑' },
          reward_count: { type: 'integer', description: '谢礼件数，默认 1' },
          reward_affinity: { type: 'integer', description: 'reward_kind 为 affinity 时的好感度数值' },
          reward_ability: { type: 'string', enum: ABILITY_IDS, description: 'reward_kind 为 ability 时选一个' },
          reward_topic: { type: 'string', description: 'reward_kind 为 info 时的情报主题' },
        },
        required: ['title', 'want', 'tier', 'objective_kind', 'reward_kind'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_quest',
      description:
        '当对方在对话里明确把东西交给你（"这个给你""你收下"）时调用。' +
        '系统会去核对并扣除对方背包里的道具，然后才结算你对他的承诺 —— ' +
        '**你自己无权决定收没收到东西，也不要抢在系统之前道谢**。',
      parameters: {
        type: 'object',
        properties: {
          quest_id: { type: 'string', description: '要提交的委托 id' },
          item_id: { type: 'string', description: '对方交付的道具 id（交付型委托必填）' },
          count: { type: 'integer', description: '交付件数' },
        },
        required: ['quest_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'decline_quest',
      description: '当对方明确表示不接这条委托时调用。系统会把你为此预留的谢礼放回背包，你可以另寻他事。',
      parameters: {
        type: 'object',
        properties: {
          quest_id: { type: 'string', description: '对方不接的那条委托 id' },
          reason: { type: 'string', description: '对方不接的缘由（可选）' },
        },
        required: ['quest_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'note_impression',
      description:
        '记一笔你对对方的印象（这是好感度的涨法）。当这一轮对方说到你心坎里、或踩了你的忌讳时调用。' +
        '同一套恭维第二次不再新鲜：系统会按冷却驳回（每 2 轮最多因印象涨一次），' +
        '所以只在真的被触动或被冒犯时才用，别把恭维当口头禅。',
      parameters: {
        type: 'object',
        properties: {
          impression: {
            type: 'string',
            enum: IMPRESSION_KINDS,
            description: 'pleased 说到心坎里（+2）/ neutral 不咸不淡（0）/ offended 冒犯了你（-1，马上生效）',
          },
          reason: { type: 'string', description: '缘由，一两句，算是你自己心里的记账' },
        },
        required: ['impression'],
        additionalProperties: false,
      },
    },
  },
];

/* ============================== 归一化工具 ============================== */

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

/** @param {string} reason @returns {{ ok: false; reason: string }} */
function fail(reason) {
  return { ok: false, reason };
}

/* ---------------------------- propose_quest ---------------------------- */

/**
 * 把模型的扁平参数收敛成领域层的委托提案。
 * 只判"形状与枚举"，不判"白名单里有没有这件道具、档位够不够" —— 那是前端裁决层的事。
 * @param {any} raw
 * @returns {{ ok: true; proposal: any } | { ok: false; reason: string }}
 */
export function normalizeQuestProposal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('提案不是对象');

  const title = asText(raw.title);
  if (!title) return fail('缺少 title');
  const want = asText(raw.want);
  if (!want) return fail('缺少 want：必须说清这个 NPC 想要什么');

  const tier = asInt(raw.tier, Number.NaN);
  if (![1, 2, 3].includes(tier)) return fail(`tier 必须是 1 / 2 / 3，收到 ${String(raw.tier)}`);

  const objectiveKind = asText(raw.objective_kind);
  let objective;
  if (objectiveKind === 'deliver_item' || objectiveKind === 'has_item') {
    const itemId = asText(raw.objective_item_id);
    if (!itemId) return fail(`${objectiveKind} 必须给出 objective_item_id`);
    const count = asInt(raw.objective_count, 1);
    if (count < 1) return fail('objective_count 必须 ≥ 1');
    objective = { kind: objectiveKind, itemId, count };
  } else if (objectiveKind === 'talk_count') {
    const rounds = asInt(raw.objective_rounds, 0);
    if (rounds < 1) return fail('talk_count 必须给出 objective_rounds ≥ 1');
    objective = { kind: 'talk_count', rounds };
  } else if (objectiveKind === 'affinity_at_least') {
    const value = asInt(raw.objective_value, 0);
    if (value < 1) return fail('affinity_at_least 必须给出 objective_value ≥ 1');
    objective = { kind: 'affinity_at_least', value };
  } else {
    return fail(
      `未知或缺失的 objective_kind：${objectiveKind || '(空)'}，只能用 ${OBJECTIVE_KINDS.join(' / ')}`,
    );
  }

  const rewardKind = asText(raw.reward_kind);
  let reward;
  if (rewardKind === 'item') {
    const itemId = asText(raw.reward_item_id);
    if (!itemId) return fail('道具谢礼必须给出 reward_item_id');
    const count = asInt(raw.reward_count, 1);
    if (count < 1) return fail('reward_count 必须 ≥ 1');
    reward = { kind: 'item', itemId, count };
  } else if (rewardKind === 'affinity') {
    const amount = asInt(raw.reward_affinity, 0);
    if (amount < 1) return fail('好感度谢礼必须给出 reward_affinity ≥ 1');
    reward = { kind: 'affinity', amount };
  } else if (rewardKind === 'ability') {
    const abilityId = asText(raw.reward_ability);
    if (!ABILITY_IDS.includes(abilityId)) {
      return fail(`未知的 reward_ability：${abilityId || '(空)'}，只能用 ${ABILITY_IDS.join(' / ')}`);
    }
    reward = { kind: 'ability', abilityId };
  } else if (rewardKind === 'info') {
    const topic = asText(raw.reward_topic);
    if (!topic) return fail('情报谢礼必须给出 reward_topic');
    reward = { kind: 'info', topic };
  } else if (rewardKind === 'none') {
    reward = { kind: 'none' };
  } else {
    return fail(`未知或缺失的 reward_kind：${rewardKind || '(空)'}，只能用 ${REWARD_KINDS.join(' / ')}`);
  }

  /** @type {{ title: string; want: string; tier: number; objective: any; reward: any }} */
  // 档位（offer_level）由前端按「事情轻重 + 为人」算，模型不再自报 —— 自报那次正是翻车的源头
  const proposal = { title: title.slice(0, 40), want: want.slice(0, 300), tier, objective, reward };
  return { ok: true, proposal };
}

/* ---------------------------- submit_quest ---------------------------- */

/**
 * 兼容两种写法：扁平 item_id/count，或嵌套 deliver:{itemId,count}
 * @param {any} raw
 * @returns {{ ok: true; submission: any } | { ok: false; reason: string }}
 */
export function normalizeQuestSubmission(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('提交参数不是对象');

  const questId = asText(raw.quest_id ?? raw.questId);
  if (!questId) return fail('缺少 quest_id');

  const nested = raw.deliver && typeof raw.deliver === 'object' ? raw.deliver : null;
  const itemId = asText(raw.item_id ?? raw.itemId ?? nested?.item_id ?? nested?.itemId);
  /** @type {{ questId: string; deliver?: { itemId: string; count: number } }} */
  const submission = { questId };
  if (itemId) {
    const count = asInt(raw.count ?? nested?.count, 1);
    if (count < 1) return fail('交付件数必须 ≥ 1');
    submission.deliver = { itemId, count };
  }
  return { ok: true, submission };
}

/* ---------------------------- decline_quest ---------------------------- */

/**
 * @param {any} raw
 * @returns {{ ok: true; decline: any } | { ok: false; reason: string }}
 */
export function normalizeQuestDecline(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('婉拒参数不是对象');
  const questId = asText(raw.quest_id ?? raw.questId);
  if (!questId) return fail('缺少 quest_id');
  const reason = asText(raw.reason).slice(0, 100);
  return { ok: true, decline: reason ? { questId, reason } : { questId } };
}

/* ---------------------------- note_impression ---------------------------- */

/**
 * @param {any} raw
 * @returns {{ ok: true; impression: any } | { ok: false; reason: string }}
 */
export function normalizeQuestImpression(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('印象参数不是对象');
  const kind = asText(raw.impression ?? raw.kind);
  if (!IMPRESSION_KINDS.includes(kind)) {
    return fail(`impression 只能是 ${IMPRESSION_KINDS.join(' / ')}，收到 ${kind || '(空)'}`);
  }
  const reason = asText(raw.reason).slice(0, 200);
  return { ok: true, impression: reason ? { kind, reason } : { kind } };
}

/* ============================== 派发 ============================== */

/**
 * 把一次委托类工具调用映射成一条 SSE 事件。
 * 归一化失败时返回 ok:false —— 调用方把它转成 notice 告诉前端（以及下一轮告诉模型）。
 * @param {string} name
 * @param {any} rawArgs
 * @returns {{ ok: true; event: any } | { ok: false; name: string; reason: string }}
 */
export function mapQuestToolCall(name, rawArgs) {
  switch (name) {
    case 'propose_quest': {
      const result = normalizeQuestProposal(rawArgs);
      if (!result.ok) return { ok: false, name, reason: result.reason };
      return { ok: true, event: { type: 'quest_proposal', proposal: result.proposal } };
    }
    case 'submit_quest': {
      const result = normalizeQuestSubmission(rawArgs);
      if (!result.ok) return { ok: false, name, reason: result.reason };
      return { ok: true, event: { type: 'quest_submit', submission: result.submission } };
    }
    case 'decline_quest': {
      const result = normalizeQuestDecline(rawArgs);
      if (!result.ok) return { ok: false, name, reason: result.reason };
      return { ok: true, event: { type: 'quest_decline', decline: result.decline } };
    }
    case 'note_impression': {
      const result = normalizeQuestImpression(rawArgs);
      if (!result.ok) return { ok: false, name, reason: result.reason };
      return { ok: true, event: { type: 'quest_impression', impression: result.impression } };
    }
    default:
      return { ok: false, name, reason: `不是委托类工具：${name}` };
  }
}
