import type { runModelCheck } from './check-model.js';

type Report = Awaited<ReturnType<typeof runModelCheck>>;
type Row = Pick<Report['results'][number], 'ruleId' | 'ruleVersion' | 'object' | 'status'>;
export type ComparisonBaseline = {
  modelVersion: string;
  evidenceInventory: { revision?: string };
  results: Row[];
  exportFeedback: { ruleId: string }[];
  clauseTrace: Pick<Report['clauseTrace'][number], 'id' | 'source'>[];
};
const key = (row: Row) => JSON.stringify([row.ruleId, row.ruleVersion, row.object?.scope ?? null,
  row.object?.table ?? null, row.object?.id ?? null]);

export function readComparisonBaseline(value: unknown, items: ComparisonBaseline['clauseTrace']): ComparisonBaseline {
  const baseline = value as ComparisonBaseline | null;
  const originals = new Map(items.map(item => [item.id, item.source]));
  if (!baseline || !/^[a-f\d]{64}$/.test(baseline.modelVersion) || !baseline.evidenceInventory ||
      !(baseline.evidenceInventory.revision === undefined || typeof baseline.evidenceInventory.revision === 'string') ||
      !Array.isArray(baseline.results) || baseline.results.length > 20_000 ||
      !Array.isArray(baseline.exportFeedback) || !Array.isArray(baseline.clauseTrace) || !baseline.clauseTrace.length ||
      baseline.clauseTrace.length > 500)
    throw new Error('复跑基线格式无效。请选择模型核查下载的基线报告。');
  const trace = new Set<string>();
  for (const row of baseline.clauseTrace) {
    const source = row && originals.get(row.id);
    if (!source || trace.has(row.id) || row.source?.document !== source.document ||
        row.source.locator !== source.locator || row.source.text !== source.text)
      throw new Error('基线的条款原文或工作表位置与当前条款不符。');
    trace.add(row.id);
  }
  for (const row of baseline.results)
    if (!row || !trace.has(row.ruleId) || typeof row.ruleVersion !== 'string' ||
        !['pass', 'fail', 'not-applicable', 'indeterminate'].includes(row.status) ||
        !(row.object === null || row.object && [row.object.scope, row.object.table, row.object.id]
          .every(value => typeof value === 'string' && !!value.trim())))
      throw new Error('基线含无法定位的条款或对象结果。');
  if (!baseline.exportFeedback.every(row => row && trace.has(row.ruleId)))
    throw new Error('基线的补证据建议无法关联到条款。');
  return baseline;
}

export function compareModelCheckReports(baseline: ComparisonBaseline, current: Report) {
  const evaluated = new Set(current.clauseTrace.filter(row => row.status === 'executed').map(row => row.id));
  const before = new Map(baseline.results.filter(row => evaluated.has(row.ruleId)).map(row => [key(row), row]));
  const after = new Map(current.results.map(row => [key(row), row]));
  const changes = [...new Set([...before.keys(), ...after.keys()])].flatMap(id => {
    const previous = before.get(id);
    const next = after.get(id);
    if (previous?.status === next?.status) return [];
    const row = (next ?? previous)!;
    return [{ ruleId: row.ruleId, ruleVersion: row.ruleVersion, object: row.object,
      before: previous?.status ?? null, after: next?.status ?? null }];
  });
  return { beforeModelVersion: baseline.modelVersion, afterModelVersion: current.modelVersion,
    beforeEvidenceRevision: baseline.evidenceInventory.revision, afterEvidenceRevision: current.evidenceInventory.revision,
    rules: [...evaluated], changes };
}
