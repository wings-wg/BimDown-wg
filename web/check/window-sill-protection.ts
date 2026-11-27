import type { EngineeringDatum } from './core/index.js';
import { textPresent } from './core/tool-recipes.js';
import { WINDOW_PROTECTION_TOOL, WINDOW_SILL_HEIGHT, validateConditionalRequirement,
  type ConditionalRequirementRule } from './conditional-requirement.js';
import type { Blocker } from './pal-readiness.js';
import { objectId, type parseEvidence, type readScopedObjectRows } from './tool-evidence.js';

export const windowKinds = { ordinary: '普通外窗', 'full-height': '落地窗', bay: '飘窗' } as const;
export const sillBases = { 'finished-floor': '室内完成地面', 'walkable-surface': '可踏面' } as const;
type WindowGuard = { object: EngineeringDatum['object']; provided: boolean; location: string; source: string; confirmed: boolean };
type Sill = { valueM: number; inputValue: number; inputUnit: 'm' | 'mm'; kind: keyof typeof windowKinds;
  basis: keyof typeof sillBases; location: string; source: string };
type WindowProtection = { threshold: number; sill?: Sill; triggered?: boolean; guard?: WindowGuard; applicabilitySource?: string };

export function readWindowGuards(value: unknown) {
  const records = new Map<string, WindowGuard>();
  const repeated = new Set<string>();
  if (value === undefined) return { records, repeated };
  if (!Array.isArray(value) || value.length > 100_000)
    return { records, repeated, error: '外窗防护证据格式无效。' };
  for (const entry of value as (WindowGuard | null)[]) {
    if (!entry?.object || entry.object.table !== 'window' ||
        ![entry.object.scope, entry.object.id, entry.location, entry.source].every(textPresent) ||
        typeof entry.provided !== 'boolean' || typeof entry.confirmed !== 'boolean')
      return { records, repeated, error: '外窗防护记录须包含外窗标识、部位、防护状态及复核来源。' };
    const key = objectId(entry.object);
    if (records.has(key)) repeated.add(key);
    else {
      const { scope, id } = entry.object;
      const { provided, confirmed, location, source } = entry;
      records.set(key, { object: { scope, table: 'window', id }, provided, confirmed, location, source });
    }
  }
  return { records, repeated };
}

export function checkWindowSillProtection(rule: ConditionalRequirementRule,
  inventory: Awaited<ReturnType<typeof readScopedObjectRows>>, guards: ReturnType<typeof readWindowGuards>,
  modelVersion: string, evidence?: ReturnType<typeof parseEvidence>, evidenceError?: string) {
  validateConditionalRequirement(rule);
  const { sillThreshold: threshold } = rule;
  const criterion: WindowProtection = { threshold };
  const base = { ruleId: rule.id, ruleVersion: rule.version, source: rule.source, modelVersion, tool: WINDOW_PROTECTION_TOOL };
  const results = [...inventory.objects].map(([key, { object, name }]) => {
    const row = { ...base, object, name };
    const pending = (reason: string, blocker: Blocker, windowProtection = criterion) =>
      ({ ...row, windowProtection, status: 'indeterminate' as const, reason, blocker });
    if (inventory.ambiguous.has(key)) return pending('同一楼层外窗编号重复。', 'input-conflict');
    if (evidenceError) return pending(evidenceError, 'invalid-evidence');
    const scopeKey = JSON.stringify([key, rule.id, rule.version, rule.applicability]);
    if (evidence?.duplicate.has(scopeKey)) return pending('同一外窗的规则适用性记录重复。', 'input-conflict');
    const decision = evidence?.applicability.get(scopeKey);
    if (!rule.reviewed || !decision) return pending('请确认窗的外窗属性及本条适用性。', 'confirm-applicability');
    if (decision.decision === 'does-not-apply')
      return { ...row, status: 'not-applicable' as const, reason: decision.source, windowProtection: criterion };
    const kind = decision.windowKind;
    if (typeof kind !== 'string' || !Object.hasOwn(windowKinds, kind))
      return pending('请确认普通外窗、落地窗或飘窗类型。', 'confirm-window-sill');

    if (evidence?.duplicate.has(JSON.stringify([key, WINDOW_SILL_HEIGHT])))
      return pending('同一外窗的窗台净高记录重复。', 'input-conflict');
    const datum = evidence?.facts.get(key)?.get(WINDOW_SILL_HEIGHT);
    const basis = kind === 'bay' ? 'walkable-surface' : 'finished-floor';
    if (!datum?.confirmed || datum.value < 0 || !textPresent(datum.measurementGroup))
      return pending('请补充带量测部位的已复核窗台净高。', 'confirm-window-sill');
    if (datum.windowSillBasis !== basis)
      return pending(`窗台净高须从已复核的${sillBases[basis]}起算。`, 'confirm-window-sill');

    const sill: Sill = { valueM: datum.unit === 'mm' ? datum.value / 1000 : datum.value,
      inputValue: datum.value, inputUnit: datum.unit, source: datum.source,
      kind: kind as keyof typeof windowKinds, basis, location: datum.measurementGroup };
    const triggered = sill.valueM < threshold;
    const details: WindowProtection = { threshold, sill, triggered, applicabilitySource: decision.source };
    if (!triggered) return { ...row, status: 'pass' as const, windowProtection: details };
    if (guards.error) return pending(guards.error, 'confirm-window-guard', details);
    if (guards.repeated.has(key)) return pending('同一外窗的防护确认记录重复。', 'input-conflict', details);
    const guard = guards.records.get(key);
    if (!guard?.confirmed) return pending('窗台净高低于限值，需复核该部位是否设有防护。', 'confirm-window-guard', details);
    if (guard.location !== sill.location)
      return pending('防护证据与窗台净高须绑定同一外窗部位。', 'input-conflict', details);
    return { ...row, status: guard.provided ? 'pass' as const : 'fail' as const,
      windowProtection: { ...details, guard } };
  });
  const missing = inventory.missingIds.size
    ? { reason: `外窗表存在缺少编号的记录：${[...inventory.missingIds].join('、')}。`, blocker: 'input-conflict' as const }
    : !results.length ? { reason: '当前模型未导出可绑定的外窗。', blocker: 'missing-object' as const } : undefined;
  return missing ? [...results, { ...base, object: null, name: undefined, status: 'indeterminate' as const, ...missing }] : results;
}
