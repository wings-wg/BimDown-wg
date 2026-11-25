import { PAL_FIELDS, parsePalClause, validatePalResponse, type PalClause } from './pal-plan.js';
import { verifyToolRecipe, type ToolEntry } from './core/tool-recipes.js';

export const candidateLimit = 20;
type Source = { document: string; locator: string; text: string };
type Entry = { clause: PalClause; source: Source; proposal: Record<string, unknown>; verification: string[] };

export function readCandidatePackage(input: unknown, items?: readonly { id: string; clause?: PalClause; source: Source }[]) {
  const payload = input as { version?: unknown; origin?: unknown; entries?: unknown } | null;
  if (payload?.version !== 1 || typeof payload.origin !== 'string' || !payload.origin.trim() || payload.origin.length > 120 ||
      !Array.isArray(payload.entries) || !payload.entries.length || payload.entries.length > candidateLimit)
    throw new Error(`候选包须为 version 1，含来源及 1 至 ${candidateLimit} 条候选。`);
  const itemIndex = items && new Map(items.map(item => [item.id, item]));
  const ids = new Set<string>();
  const entries: Entry[] = payload.entries.map(row => {
    const clause = parsePalClause(row?.clause);
    if (!clause || ids.has(clause.id)) throw new Error('候选包缺少有效原文或条款编号重复。');
    ids.add(clause.id);
    const { source, proposal, verification } = row as Partial<Entry>;
    if (!source || !['document', 'locator', 'text'].every(key => {
      const value = source[key as 'document' | 'locator' | 'text'];
      return typeof value === 'string' && !!value.trim() && value.length <= 2_400;
    }) || !proposal || typeof proposal !== 'object' || Array.isArray(proposal) || proposal.id !== clause.id ||
        !Array.isArray(verification) || verification.length > 12 || !verification.every(check => typeof check === 'string'))
      throw new Error(`${clause.id} 缺少原文位置、方案或验证记录。`);
    if (itemIndex) {
      const item = itemIndex.get(clause.id);
      if (!item?.clause || PAL_FIELDS.some(field => item.clause![field] !== clause[field]) ||
          item.source.document !== source.document || item.source.locator !== source.locator || item.source.text !== source.text)
        throw new Error(`${clause.id} 的原文或工作表位置与当前条款不匹配。`);
    }
    return { clause, source, proposal, verification };
  });
  return { version: 1 as const, origin: payload.origin.trim(), entries };
}

export function verifyCandidatePackage(input: unknown, tools: readonly ToolEntry[]) {
  const { origin, entries } = readCandidatePackage(input);
  const plans = entries.map(({ clause, proposal, verification }) => {
    const [result] = validatePalResponse(JSON.stringify({ rules: [proposal] }), [clause], tools);
    if (result.plan.kind === 'blocked') throw new Error(`${clause.id} 验证失败，${result.plan.reason}`);
    const checks = 'recipe' in result.plan ? verifyToolRecipe(result.plan.recipe) : [];
    if (checks.length !== verification.length || checks.some(check => !verification.includes(check)))
      throw new Error(`${clause.id} 的验证记录和本机固定用例不一致。`);
    return { ...result, checks };
  });
  return { origin, plans };
}
