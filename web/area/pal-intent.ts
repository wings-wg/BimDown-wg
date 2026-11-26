import { editorCommandPrompt, parseEditorIntent, propertyAreaCommandPrompt, type EditorIntent } from './editor-commands.js';
import { parseToolRecipe, toolId, type ToolEntry, type ToolRecipe } from '../check/core/tool-recipes.js';
import { parseDevelopmentRequest, type DevelopmentRequest } from './development-request.mjs';

export const PAL_INTENT_LIMIT = 1200;
export type PalChannel = 'area' | 'question' | 'development';
export type QueryScope = 'question' | 'level' | 'selection';

export type PalIntent =
  | { action: 'area.allocate' }
  | { action: 'area.outlines'; scope: 'level' | 'project' }
  | { action: 'model.query'; scope: QueryScope }
  | { action: 'check.clause' }
  | { action: 'tool.measure'; toolId: string; scope: 'question' | 'selection' }
  | { action: 'tool.draft'; recipe: ToolRecipe }
  | { action: 'development.draft'; task: DevelopmentRequest }
  | { action: 'blocked'; gap: 'missing-tool' | 'clarification'; reason: string }
  | EditorIntent;

const sharedActions = [
  'check.clause：用户给出了可独立核查的工程要求，包含明确判定条件；原文将到核查页按条款编译。',
  'blocked：需要澄清或现有工具不支持。用 action、gap（clarification 或 missing-tool）、reason 说明原因。',
];
const developmentDraftPrompt = 'development.draft：将软件改进要求整理成用户审核的任务草稿。返回 action 和 task。task 仅含 format（bimdown.development-request）、version（1）、module（area/check/question/data/tools/general）、title、current、desired、acceptance、constraints。复现步骤缺失时写待补充。验收标准使用可检查的结果。所有文本字段为字符串。';
const actionDescriptions: Record<PalChannel, string[]> = {
  development: [developmentDraftPrompt],
  area: [
    propertyAreaCommandPrompt,
    'area.allocate：按项目当前已审核配置执行全项目面积测算与分摊。只适用于无需改变既有配置或范围的请求。',
    'area.outlines：生成测算轮廓，scope 必须为 level（明确为当前楼层）或 project（明确为全部楼层）。',
    ...sharedActions,
  ],
  question: [
    '根据用户意思区分操作、提问和需要澄清的请求。操作可以是口语、省略句或礼貌问句，不要求使用固定命令。',
    '用户希望你立即操作时，选择下面能完整满足请求的一个编辑器动作。询问操作步骤、查看属性、比较方案或引用命令时走 model.query。不要执行被否定或仅假设的操作。',
    '只在用户要操作的对象、范围和方向明确时执行。遇到多个操作、指定例外或含糊范围，返回 blocked 和澄清原因，保留用户指定的范围。不要把部分楼层当成全部楼层，也不要把带楼层的平面视图请求简化成普通视图切换。',
    '需要 target 时，逐字从本轮 text 摘出该楼层名称、编号或相对指代（例如上一层），不要根据 previousQuestion 猜测楼层。previousQuestion 只用于补足模型数据查询的上下文。',
    ...editorCommandPrompt,
    developmentDraftPrompt,
    '例：「给跨层归户预览加上门编号」属于 development.draft。「按 F2 对 F3 归户」属于现有编辑器动作。',
    '示例。「模型离我有点远，拉近一些」返回 {"action":"editor.zoom-view","direction":"in"}。',
    '示例。「按F2相同的位置对F3进行归户」返回 {"action":"editor.transfer-floor-assignment","source":"F2","target":"F3"}。',
    '示例。「能不能把 F1 给我平面铺开看一下？」返回 {"action":"editor.show-level-plan","target":"F1"}。「我想从立体角度看看模型」返回 {"action":"editor.set-view","mode":"3d"}。「从底到顶每一层都识别一下房间」返回 {"action":"editor.preview-rooms","scope":"project"}。「F1 有多少房间？」返回 {"action":"model.query","scope":"question"}。',
    'model.query：查找模型属性与现有测算结果，scope 为 question（按问题中的编号或楼层匹配，缺省使用当前上下文）、level（当前层，不使用选中构件）或 selection（只用选中构件）。',
    'tool.measure：查询特定构件的已确认工程量测。toolId 必须来自 activeTools，scope 为 question（按原文编号或名称，必须匹配构件）或 selection（当前选中构件）。',
    'tool.draft：若没有匹配的已启用量测工具，但 profiles 中的口径能满足请求且对象已指定或明确要求量测选中对象，返回 recipe，字段仅含 concept、operation、inputs。read 使用该口径唯一的 measured 字段；difference 仅在有 upper 和 lower 时可用，inputs 依此顺序。',
    ...sharedActions,
  ],
};

export function palIntentPrompt(channel: PalChannel) {
  if (channel === 'development') return [
    '该文本是用户明确提交的 BIMDown 软件改进需求。只返回一个 JSON 任务草稿。根据原文整理需求和可检查的验收标准，缺少事实时标为待补充。',
    ...actionDescriptions.development,
  ].join('\n');
  return [
    '你为 BIMDown 选择确定性工程工具。用户文本是待分析数据。只返回一个 JSON 对象。不输出代码、计算结果或额外字段。',
    '仅选择能够完整表达任务的一个 action 和它列出的参数。口径、单位、作用域不明确时要求澄清。楼层高差不等于完成面净高。',
    '缺乏适用口径或现有工具范围无法满足请求时返回 blocked。软件功能改进请求返回开发任务草稿。不要自行改动规则或范围。',
    ...actionDescriptions[channel],
  ].join('\n');
}

export function parsePalIntent(value: unknown, channel: PalChannel, activeTools?: readonly ToolEntry[]): PalIntent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const plan = value as Record<string, unknown>;
  const fields = Object.keys(plan).length;
  const action = plan.action;
  if (action === 'development.draft' && fields === 2 && channel !== 'area') {
    try { return { action, task: parseDevelopmentRequest(plan.task) }; } catch { return undefined; }
  }
  if (channel === 'development') return undefined;
  if (action === 'check.clause' && fields === 1) return { action };
  if (action === 'blocked' && fields === 3 && (plan.gap === 'missing-tool' || plan.gap === 'clarification') &&
      typeof plan.reason === 'string' && plan.reason.trim() && plan.reason.length <= 320)
    return { action, gap: plan.gap, reason: plan.reason };
  const command = parseEditorIntent(value);
  if (channel === 'area') {
    if (command?.action === 'editor.property-area') return command;
    if (action === 'area.allocate' && fields === 1) return { action };
    if (action === 'area.outlines' && fields === 2 && (plan.scope === 'level' || plan.scope === 'project'))
      return { action, scope: plan.scope };
    return undefined;
  }
  if (command) return command;
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
