import { validateRule, type EngineeringRule } from './core/index.js';
import { validateClearHeightRule, type ClearHeightRule } from './core/clear-height.js';
import type { ScalarRuleSet } from './core/rule-set.js';
import { HEIGHT, ROOM_NET_AREA, localStoreyHeightPlan, parsePalClause, scalarBindings, type PalClause, type PalPlan } from './pal-plan.js';
import { parseToolRecipe, TOOL_PROFILES, toolId, type ToolEntry } from './core/tool-recipes.js';
import { DOOR_WIDTH, validateDoorWidthRule, type DoorWidthRule } from './door-width.js';
import { validateSpaceOverlapRule, type SpaceOverlapRule } from './space-overlap.js';

export { HEIGHT, ROOM_NET_AREA } from './pal-plan.js';
type Rule = ScalarRuleSet['rules'][number];
export interface CheckItem {
  id: string;
  title: string;
  source: EngineeringRule['source'];
  rule?: Rule;
  clearHeightRule?: ClearHeightRule;
  doorWidthRule?: DoorWidthRule;
  overlapRule?: SpaceOverlapRule;
  reason?: string;
  clause?: PalClause;
  plan?: PalPlan;
  libraryTool?: ToolEntry;
  compiledLocally?: boolean;
}
export type SheetRow = { number: number; cells: ReadonlyMap<number, string>; formulaColumns: ReadonlySet<number> };
export const MAX_CLAUSE_TEXT_LENGTH = 800;

export async function importTextRule(text: string): Promise<CheckItem> {
  const condition = text.trim();
  if (!condition || condition.length > MAX_CLAUSE_TEXT_LENGTH)
    throw new Error('请输入一条不超过 800 字的完整核查要求。');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(condition));
  const id = `TEXT-${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const clause = { id, condition, target: '', attribute: '', limit: '', reference: '', applicability: '', note: '' };
  return { id, title: '文本条款', clause, reason: '等待 PAL 编译。',
    source: { document: '用户输入', locator: '模型核查 · 自然语言条款', text: condition } };
}

function ensureItems(items: CheckItem[]) {
  if (!items.length || items.length > 500) throw new Error('条款数量须在 1 至 500 条之间。');
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('条款编号重复，请核对文件。');
  return items;
}

export function importJsonRules(text: string, tools: readonly ToolEntry[] = []): CheckItem[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.rules)) throw new Error('JSON 文件须包含 rules 数组。');
  return ensureItems(parsed.rules.map((rule: (Rule & { registeredToolId?: string }) | ClearHeightRule | DoorWidthRule | SpaceOverlapRule): CheckItem => {
    if (rule && 'kind' in rule && rule.kind === 'space-projection-exclusion') {
      validateSpaceOverlapRule(rule);
      const base = { id: rule.id, source: rule.source, title: '跨层空间投影叠合' };
      return rule.reviewed ? { ...base, overlapRule: rule } : { ...base, reason: '规则包中的条款尚未审核。' };
    }
    if (rule && 'kind' in rule && rule.kind === 'door-clear-width-by-use') {
      validateDoorWidthRule(rule);
      const base = { id: rule.id, source: rule.source, title: '按用途核查门有效通行净宽' };
      const libraryTool = tools.find(tool => tool.id === rule.registeredToolId && tool.status === 'active');
      return rule.reviewed && libraryTool ? { ...base, doorWidthRule: rule, libraryTool }
        : { ...base, reason: '规则或指定的门净宽工具尚未审核启用。' };
    }
    if (rule && 'kind' in rule && rule.kind === 'clear-height-with-local-exception') {
      validateClearHeightRule(rule);
      const base = { id: rule.id, source: rule.source, title: '房间完成面净高及局部例外' };
      return rule.reviewed ? { ...base, clearHeightRule: rule }
        : { ...base, reason: '规则包中的条款尚未审核。' };
    }
    validateRule(rule);
    const { id, source, targetTable, concept, unit } = rule;
    const base = { id, source, title: concept === HEIGHT ? '建筑层高' : concept === ROOM_NET_AREA ? '模型记载房间净面积' : concept };
    if (!rule.reviewed) return { ...base, reason: '规则包中的条款尚未审核。' };
    if (rule.registeredToolId) {
      const libraryTool = tools.find(tool => tool.status === 'active' && tool.id === rule.registeredToolId);
      if (libraryTool && libraryTool.recipe.concept === concept && TOOL_PROFILES[libraryTool.recipe.concept].table === targetTable && unit === 'm')
        return { ...base, rule, libraryTool };
      return { ...base, reason: '规则指定的工具版本未启用或口径不匹配。' };
    }
    if ((targetTable === 'level' && concept === HEIGHT && unit === 'm') ||
        (targetTable === 'space' && concept === ROOM_NET_AREA && unit === 'm2'))
      return { ...base, rule };
    return { ...base, reason: '网页尚未支持该对象、工程概念和单位的组合。' };
  }));
}

export function bindPalPlan(item: CheckItem, plan: PalPlan, tools: readonly ToolEntry[] = []): CheckItem {
  if (!item.clause) return item;
  const base = { ...item, plan, rule: undefined, clearHeightRule: undefined, doorWidthRule: undefined,
    overlapRule: undefined, libraryTool: undefined, reason: undefined };
  if (plan.kind === 'blocked') return { ...base, reason: plan.reason };
  const common = { id: item.id, source: item.source, version: 'pal-1', reviewed: false,
    applicability: item.clause.applicability || item.clause.target || '适用范围须由审核人确认' };
  try {
    if (plan.kind === 'space-projection-exclusion') {
      const overlapRule = { ...common, kind: plan.kind };
      validateSpaceOverlapRule(overlapRule);
      return { ...base, overlapRule };
    }
    if (plan.kind === 'registered-tool' || plan.kind === 'tool-draft' || plan.kind === 'door-clear-width-by-use') {
      const recipe = parseToolRecipe(plan.recipe);
      const libraryTool = tools.find(tool => tool.id === plan.toolId && tool.status === 'active');
      if (!recipe || !libraryTool || toolId(recipe) !== libraryTool.id)
        return { ...base, reason: '候选工具待审核启用。' };
      if (plan.kind === 'door-clear-width-by-use') {
        if (recipe.concept !== DOOR_WIDTH) throw new Error('unsupported binding');
        const doorWidthRule = { ...common, kind: plan.kind, thresholds: plan.thresholds, registeredToolId: libraryTool.id };
        validateDoorWidthRule(doorWidthRule);
        return { ...base, doorWidthRule, libraryTool };
      }
      const binding = TOOL_PROFILES[recipe.concept];
      const note = item.clause.note;
      const applicability = recipe.concept === 'slab.cast-in-place-solid-structural-thickness' && /悬挑|空心|叠合/.test(note)
        ? `${common.applicability}；仅已确认适用此基本限值的现浇实心楼板。另判依据：${note}` : common.applicability;
      const rule = { ...common, applicability, targetTable: binding.table, unit: binding.unit, concept: recipe.concept,
        operator: plan.operator, threshold: plan.threshold };
      validateRule(rule);
      return { ...base, plan: { ...plan, kind: 'registered-tool' }, rule, libraryTool };
    }
    if (plan.kind === 'scalar') {
      const binding = scalarBindings[plan.concept];
      if (!binding || binding.scope !== plan.scope || !(plan.threshold > 0)) throw new Error('unsupported binding');
      const rule = { ...common, targetTable: binding.table, unit: binding.unit, concept: plan.concept,
        operator: plan.operator, threshold: plan.threshold };
      validateRule(rule);
      return { ...base, rule };
    }
    if (plan.kind === 'clear-height-with-local-exception' && plan.scope === 'ordinary-residential-rooms') {
      const clearHeightRule = { ...common, kind: plan.kind, nominalHeight: plan.nominalHeight, minimumHeight: plan.minimumHeight,
        maxLowAreaFraction: plan.maxLowAreaFraction };
      validateClearHeightRule(clearHeightRule);
      return { ...base, clearHeightRule };
    }
  } catch { /* An invalid server response remains pending. */ }
  return { ...base, reason: '规则无法绑定到本地核查工具。' };
}

export function bindLocalStoreyHeight(item: CheckItem): CheckItem {
  const clause = item.clause;
  if (!clause) return item;
  const plan = localStoreyHeightPlan(clause);
  if (!plan) return item;
  const bound = bindPalPlan({ ...item, clause: {
    ...clause, applicability: `${clause.applicability} · ${clause.limit}`,
  } }, plan);
  return bound.rule ? { ...bound, clause: item.clause, compiledLocally: true } : item;
}

const sheetColumns = [
  ['编号', '条款编号', '规则编号'], ['核查对象', '适用对象'], ['核查属性', '核查指标'],
  ['判定条件', '条款内容', '条款正文', '核查要求'], ['阈值或限值', '限值'],
  ['依据规范', '规范依据'], ['适用条件', '适用范围'], ['备注'],
];

export function importSheetRules(document: string, sheet: string, rows: SheetRow[]): CheckItem[] {
  const matches = (row: SheetRow, index: number) =>
    [...row.cells].filter(([, value]) => sheetColumns[index].some(label => value.startsWith(label))).map(([column]) => column);
  const header = rows.find(row => matches(row, 0).length && matches(row, 3).length);
  if (!header) throw new Error('工作表须包含「编号」和「判定条件」或「条款内容」。');
  const columns = sheetColumns.map((_, index) => matches(header, index));
  if (columns.some(matches => matches.length > 1)) throw new Error('规则表的列名有重复。');

  return ensureItems(rows.filter(row => row.number > header.number && [...row.cells.values()].some(Boolean)).map(row => {
    const [id, target, attribute, condition, limit, reference, applicability, note] =
      columns.map(([column]) => row.cells.get(column) ?? '');
    if (!id || row.formulaColumns.has(columns[0][0])) throw new Error(`第 ${row.number} 行缺少静态条款编号。`);
    const source = { document, locator: `${sheet} · 第 ${row.number} 行`,
      text: [target, attribute, condition, limit, reference, applicability, note].filter(Boolean).join('；') || '该行缺少判定内容。' };
    const base = { id, title: target || id, source };
    if (columns.some(([column]) => row.formulaColumns.has(column))) return { ...base, reason: '条款字段含公式，请提供静态条款。' };
    if (!condition && !limit) return { ...base, reason: '条款缺少判定条件或限值。' };
    const clause = parsePalClause({ id, target, attribute, condition, limit, reference, applicability, note });
    return clause ? { ...base, clause, reason: '等待 PAL 编译。' } : { ...base, reason: '条款过长，请拆成可独立核查的条款。' };
  }));
}
