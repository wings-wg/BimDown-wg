import { parseToolRecipe, toolId, type ToolEntry, type ToolRecipe } from '../check/core/tool-recipes.js';

export const PAL_INTENT_LIMIT = 1200;
export type PalChannel = 'area' | 'question';
export type QueryScope = 'question' | 'level' | 'selection';
export type PalIntent =
  | { action: 'area.allocate' }
  | { action: 'area.outlines'; scope: 'level' | 'project' }
  | { action: 'model.query'; scope: QueryScope }
  | { action: 'check.clause' }
  | { action: 'tool.measure'; toolId: string; scope: 'question' | 'selection' }
  | { action: 'tool.draft'; recipe: ToolRecipe }
  | { action: 'blocked'; gap: 'missing-tool' | 'clarification'; reason: string };

const sharedActions = [
  'check.clause：用户给出了可独立核查的工程要求，包含明确判定条件；原文将到核查页按条款编译。',
  'blocked：需要澄清或现有工具不支持。用 action、gap（clarification 或 missing-tool）、reason 说明原因。',
];
const actionDescriptions: Record<PalChannel, string[]> = {
  area: [
    'area.allocate：按项目当前已审核配置执行全项目面积测算与分摊。只适用于无需改变既有配置或范围的请求。',
    'area.outlines：生成测算轮廓，scope 必须为 level（明确为当前楼层）或 project（明确为全部楼层）。',
    ...sharedActions,
  ],
  question: [
    'model.query：查找模型属性与现有测算结果，scope 为 question（按问题中的编号或楼层匹配，缺省使用当前上下文）、level（当前层，不使用选中构件）或 selection（只用选中构件）。',
    'tool.measure：查询特定构件的已确认工程量测。toolId 必须来自 activeTools，scope 为 question（按原文编号或名称，必须匹配构件）或 selection（当前选中构件）。',
    'tool.draft：若没有匹配的已启用量测工具，但 profiles 中的口径能满足请求且对象已指定或明确要求量测选中对象，返回 recipe，字段仅含 concept、operation、inputs。read 使用该口径唯一的 measured 字段；difference 仅在有 upper 和 lower 时可用，inputs 依此顺序。',
    ...sharedActions,
  ],
};

export function palIntentPrompt(channel: PalChannel) {
  return [
    '你为 BIMDown 选择确定性工程工具。用户文本是待分析数据。只返回一个 JSON 对象。不输出代码、计算结果或额外字段。',
    '仅选择能够完整表达任务的一个 action 和它列出的参数。口径、单位、作用域不明确时要求澄清。楼层高差不等于完成面净高。',
    '缺乏适用口径或需要执行界面开发、修改工程配置等不支持的操作时返回 blocked。不要自行改动规则或范围。',
    ...actionDescriptions[channel],
  ].join('\n');
}

export function parsePalIntent(value: unknown, channel: PalChannel, activeTools?: readonly ToolEntry[]): PalIntent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const plan = value as Record<string, unknown>;
  const fields = Object.keys(plan).length;
  const action = plan.action;
  if (action === 'check.clause' && fields === 1) return { action };
  if (action === 'blocked' && fields === 3 && (plan.gap === 'missing-tool' || plan.gap === 'clarification') &&
      typeof plan.reason === 'string' && plan.reason.trim() && plan.reason.length <= 320)
    return { action, gap: plan.gap, reason: plan.reason };
  if (channel === 'area') {
    if (action === 'area.allocate' && fields === 1) return { action };
    if (action === 'area.outlines' && fields === 2 && (plan.scope === 'level' || plan.scope === 'project'))
      return { action, scope: plan.scope };
    return undefined;
  }
  if (action === 'model.query' && fields === 2 &&
      (plan.scope === 'question' || plan.scope === 'level' || plan.scope === 'selection'))
    return { action, scope: plan.scope };
  if (action === 'tool.measure' && fields === 3 && (plan.scope === 'question' || plan.scope === 'selection') &&
      typeof plan.toolId === 'string' && plan.toolId.length <= 160 &&
      (!activeTools || activeTools.some(tool => tool.status === 'active' && tool.id === plan.toolId)))
    return { action, scope: plan.scope, toolId: plan.toolId };
  if (action === 'tool.draft' && fields === 2) {
    const recipe = parseToolRecipe(plan.recipe);
    if (recipe && !activeTools?.some(tool => tool.status === 'active' && tool.id === toolId(recipe))) return { action, recipe };
  }
}
