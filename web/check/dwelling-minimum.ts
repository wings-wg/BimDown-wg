import { evaluateDwellingMinimum, sameDwellingMinimum, validDwellingMinimum, type MinimumDwellingCount } from './core/dwelling-count.js';
import { textPresent } from './core/tool-recipes.js';
import { validateDwellingMinimumRule, type DwellingMinimumRule } from './dwelling-minimum-rule.js';
import type { Blocker } from './pal-readiness.js';
import { objectId, type parseEvidence } from './tool-evidence.js';

type Dwelling = { building: string; id: string; accessible: boolean | null; confirmed: boolean; source?: string };
type DwellingInventory = {
  projectId: string; scope: 'whole-residential-project'; complete: boolean; expectedCount: number;
  scopeSource: string; countSource: string; dwellings: Dwelling[];
};

export function inspectDwellingInventory(value: unknown, projectId: string | undefined) {
  if (!projectId || !value)
    return { problem: '请补充项目编号和整项目住房清单。', blocker: 'confirm-dwelling-inventory' as const };
  const inventory = value as Partial<DwellingInventory>;
  if (inventory.projectId !== projectId || inventory.scope !== 'whole-residential-project')
    return { problem: '住房清单的项目编号或范围与整项目核查不符。', blocker: 'input-conflict' as const };
  const { dwellings, expectedCount, complete, scopeSource, countSource } = inventory;
  if (!Array.isArray(dwellings) || dwellings.length > 20_000 || dwellings.some(unit => !unit ||
      ![unit.building, unit.id].every(textPresent) || (unit.accessible !== null && typeof unit.accessible !== 'boolean') ||
      typeof unit.confirmed !== 'boolean' || (unit.source !== undefined && typeof unit.source !== 'string')))
    return { problem: '逐户记录缺少有效的幢号、户号或分类。', blocker: 'confirm-dwelling-inventory' as const };
  const keys = new Set(dwellings.map(unit => JSON.stringify([unit.building.trim(), unit.id.trim()])));
  if (keys.size !== dwellings.length)
    return { problem: '同一楼幢内有重复户号，请核对整项目住房清单。', blocker: 'input-conflict' as const };
  if (complete !== true || typeof expectedCount !== 'number' || !Number.isSafeInteger(expectedCount) || expectedCount <= 0 ||
      !textPresent(scopeSource) || !textPresent(countSource))
    return { problem: '整项目范围和独立核定总户数须经复核，并填写各自来源。', blocker: 'confirm-dwelling-inventory' as const };
  if (dwellings.length !== expectedCount)
    return { problem: `逐户记录数 ${dwellings.length} 与独立核定总户数 ${expectedCount} 不一致。`,
      blocker: 'confirm-dwelling-inventory' as const };
  const rows = dwellings.map(({ building, id, accessible, source, confirmed }) => ({ building: building.trim(), id: id.trim(),
    accessible, source: source?.trim(), confirmed: confirmed && accessible !== null && textPresent(source) }));
  return { inventory: { projectId, scope: inventory.scope, complete, scopeSource, countSource, expectedCount, dwellings: rows },
    confirmedAccessible: rows.filter(row => row.confirmed && row.accessible).length,
    unconfirmed: rows.filter(row => !row.confirmed) };
}

export function checkDwellingMinimum(rule: DwellingMinimumRule, projectId: string | undefined,
  inspection: ReturnType<typeof inspectDwellingInventory>, modelVersion: string, evidence?: ReturnType<typeof parseEvidence>, evidenceError?: string) {
  validateDwellingMinimumRule(rule);
  const object = projectId ? { scope: 'global', table: 'project', id: projectId } : null;
  const base = { ruleId: rule.id, ruleVersion: rule.version, source: rule.source, modelVersion,
    tool: 'dwelling-count-minimum@1', resultScope: 'project' as const, object,
    name: projectId ? `项目 ${projectId}` : '整项目住宅配建' };
  const pending = (reason: string, blocker: Blocker) => ({ ...base, status: 'indeterminate' as const, reason, blocker });
  if (evidenceError) return pending(evidenceError, 'invalid-evidence');
  if (!object) return pending(inspection.problem ?? '工程数据缺少项目编号。', 'confirm-dwelling-inventory');
  const applicationKey = JSON.stringify([objectId(object), rule.id, rule.version, rule.applicability]);
  if (evidence?.duplicate.has(applicationKey)) return pending('同一项目和规则的适用性记录重复。', 'input-conflict');
  const decision = evidence?.applicability.get(applicationKey);
  if (rule.reviewed && decision?.decision === 'does-not-apply')
    return { ...base, status: 'not-applicable' as const, reason: decision.source };
  if (!inspection.inventory) return pending(inspection.problem, inspection.blocker);
  if (!rule.reviewed || !decision)
    return pending('请确认该新建住宅项目适用本条款及相应配建依据。', 'confirm-dwelling-rule-basis');
  const basis = decision.dwellingCountBasis as (MinimumDwellingCount & { source?: string }) | undefined;
  if (!validDwellingMinimum(basis) || !textPresent(basis.source))
    return pending('请提供已复核的配建依据、最低套数和比例。', 'confirm-dwelling-rule-basis');
  if (!sameDwellingMinimum(basis, rule))
    return pending('已复核配建依据的限值与条款不一致，请核对采用版本及地方规定。', 'input-conflict');
  if (inspection.unconfirmed.length) {
    const examples = inspection.unconfirmed.slice(0, 5).map(row => `${row.building}/${row.id}`).join('、');
    return pending(`有 ${inspection.unconfirmed.length} 户缺少已确认的无障碍住房分类或来源。待核户包括 ${examples}。`,
      'confirm-dwelling-classification');
  }
  const count = evaluateDwellingMinimum(inspection.inventory.expectedCount, inspection.confirmedAccessible, rule);
  return { ...base, status: count.shortfall ? 'fail' as const : 'pass' as const, dwellingCount: {
    ...count, minimumCount: rule.minimumCount, minimumFraction: rule.minimumFraction,
    scopeSource: inspection.inventory.scopeSource, countSource: inspection.inventory.countSource, basisSource: basis.source,
    applicabilitySource: decision.source,
  } };
}
