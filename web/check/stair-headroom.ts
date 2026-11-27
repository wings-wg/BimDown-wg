import { parseCsv, type DataSource } from 'bimdown-editor';
import { executeRule, type EngineeringDatum } from './core/index.js';
import { textPresent } from './core/tool-recipes.js';
import { stairHeadroomBranches, stairHeadroomTables, validateComponentMinimum,
  type ComponentMinimumRule } from './component-minimum.js';
import { objectId, type parseEvidence } from './tool-evidence.js';
import type { Blocker } from './pal-readiness.js';

const tables = Object.keys(stairHeadroomTables) as (keyof typeof stairHeadroomTables)[];
type Evidence = ReturnType<typeof parseEvidence>;
type ObjectRef = EngineeringDatum['object'];
type Coverage = { object: ObjectRef; source: string; location: string; confirmed: boolean;
  coversStructure: boolean; coversServices: boolean };

function readCoverage(value: unknown) {
  const byObject = new Map<string, Coverage>();
  const repeated = new Set<string>();
  if (value === undefined) return { byObject, repeated };
  if (!Array.isArray(value) || value.length > 100_000) throw new Error('楼梯净空障碍复核记录格式无效。');
  for (const entry of value as (Coverage | null)[]) {
    if (!entry?.object || !Object.hasOwn(stairHeadroomTables, entry.object.table) ||
        ![entry.object.scope, entry.object.id, entry.source, entry.location].every(textPresent) ||
        ![entry.confirmed, entry.coversStructure, entry.coversServices].every(flag => typeof flag === 'boolean'))
      throw new Error('楼梯净空障碍复核记录缺少构件、测点或来源。');
    const key = objectId(entry.object);
    if (byObject.has(key)) repeated.add(key);
    else byObject.set(key, entry);
  }
  return { byObject, repeated };
}

export async function readStairHeadroomInventory(ds: Pick<DataSource, 'fetchText'>, levels: { id: string; name: string }[]) {
  const sources = await Promise.all(levels.flatMap(level => tables.map(async table => ({
    level, table, text: await ds.fetchText(`${level.id}/${table}.csv`),
  }))));
  const objects = new Map<string, {
    object: { scope: string; table: typeof tables[number]; id: string }; name: string; host: string; repeatedTo: string;
  }>();
  const duplicates = new Set<string>();
  const missingIds = new Set<string>();
  for (const { level, table, text } of sources) {
    if (!text) continue;
    for (const row of parseCsv(text.replace(/^\uFEFF/, ''))) {
      if (!textPresent(row.id)) {
        missingIds.add(`${level.id}/${table}.csv`);
        continue;
      }
      const object = { scope: level.id, table, id: row.id };
      const key = objectId(object);
      if (objects.has(key)) duplicates.add(key);
      else objects.set(key, { object, name: `${level.name} · ${row.name || row.id}`,
        host: row.host_id ?? '', repeatedTo: row.multistory_top_level_id ?? '' });
    }
  }
  return { objects, duplicates, missingIds, snapshot: sources.map(({ level, table, text }) => [level.id, table, text]) };
}

export function checkStairHeadroom(rule: ComponentMinimumRule,
  inventory: Awaited<ReturnType<typeof readStairHeadroomInventory>>, modelVersion: string, evidence?: Evidence, evidenceError?: string) {
  validateComponentMinimum(rule);
  const base = { ruleId: rule.id, ruleVersion: rule.version, source: rule.source, modelVersion, tool: 'component-minimum@1' };
  const coverage = (() => {
    try { return { value: readCoverage(evidence?.stairHeadroomCoverage) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  })();
  const results = [...inventory.objects].map(([key, { object, name, host, repeatedTo }]) => {
    const branch = stairHeadroomTables[object.table];
    const { concept } = stairHeadroomBranches[branch];
    const threshold = rule.thresholds[branch];
    const row = { ...base, object, name, componentMinimum: { branch, threshold } };
    const pending = (reason: string, blocker: Blocker) => ({ ...row, status: 'indeterminate' as const, reason, blocker });
    if (inventory.duplicates.has(key)) return pending('同一楼层构件表中的楼梯构件编号重复。', 'input-conflict');
    const parentKey = objectId({ scope: object.scope, table: 'stair', id: host });
    const parent = inventory.objects.get(parentKey);
    if (object.table !== 'stair' && (!parent || inventory.duplicates.has(parentKey)))
      return pending('楼梯子构件缺少同层唯一宿主，无法确认实体部位。', 'confirm-stair-component');
    if (repeatedTo.trim() || parent?.repeatedTo.trim())
      return pending('多层重复楼梯需逐实例导出和复核净空。', 'confirm-stair-component');
    if (evidenceError) return pending(evidenceError, 'invalid-evidence');
    const applicabilityKey = JSON.stringify([key, rule.id, rule.version, rule.applicability]);
    if (evidence?.duplicate.has(applicabilityKey)) return pending('楼梯构件的适用性证据重复。', 'input-conflict');
    const decision = evidence?.applicability.get(applicabilityKey);
    if (!rule.reviewed || !decision)
      return pending('请确认楼梯构件的实际部位及本条规则适用性。', 'confirm-applicability');
    if (decision.decision === 'does-not-apply')
      return { ...row, status: 'not-applicable' as const, applicabilitySource: decision.source };
    const measurementKey = JSON.stringify([key, concept]);
    if (coverage.value?.repeated.has(key) || evidence?.duplicate.has(measurementKey))
      return pending('同一构件的净空量测或障碍覆盖记录重复。', 'input-conflict');
    const datum = evidence?.facts.get(key)?.get(concept);
    const reviewedCoverage = coverage.value?.byObject.get(key);
    if (coverage.error) return pending(coverage.error, 'confirm-stair-obstructions');
    if (!reviewedCoverage?.confirmed || !reviewedCoverage.coversServices || !reviewedCoverage.coversStructure)
      return pending('请提供测点和已确认的结构、风管及其他管线障碍覆盖记录。', 'confirm-stair-obstructions');
    if (!datum?.confirmed || datum.value <= 0)
      return pending('缺少该部位已确认的最低垂直净高量测。', 'confirm-measurement');
    if (datum.measurementGroup !== reviewedCoverage.location)
      return pending('最低净高量测与障碍覆盖记录须引用同一测点。', 'input-conflict');
    const normalized = datum.unit === 'mm' ? datum.value / 1000 : datum.value;
    const result = executeRule({ ...rule, concept, unit: 'm', operator: '>=', threshold },
      { ...datum, unit: 'm', value: normalized, modelVersion });
    return { ...result, ...row, applicabilitySource: decision.source, headroomCoverage: reviewedCoverage,
      ...('evidence' in result && { evidence: { ...result.evidence, inputValue: datum.value, inputUnit: datum.unit } }) };
  });
  const missing = inventory.missingIds.size > 0
    ? { reason: `楼梯构件缺少编号：${[...inventory.missingIds].join('、')}。`, blocker: 'input-conflict' as const }
    : !results.length ? { reason: '当前模型未导出可绑定的楼梯梯段或平台对象。', blocker: 'missing-object' as const } : undefined;
  return missing ? [...results, { ...base, object: null, name: undefined, status: 'indeterminate' as const, ...missing }] : results;
}
