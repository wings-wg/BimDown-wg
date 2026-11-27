import type { runModelCheck } from './check-model.js';
import type { CheckRunFingerprint } from './check-run-fingerprint.js';
import { blockerLabels, type Blocker } from './pal-readiness.js';

type Report = Awaited<ReturnType<typeof runModelCheck>>;
type Row = Pick<Report['results'][number], 'ruleId' | 'ruleVersion' | 'object' | 'status'> & {
  diagnosis?: { blockers: Blocker[] };
};
type Trace = Pick<Report['clauseTrace'][number], 'id' | 'source'> & { execution?: CheckRunFingerprint };
export type ComparisonBaseline = {
  modelVersion: string;
  evidenceInventory: { revision?: string };
  results: Row[];
  exportFeedback: { ruleId: string }[];
  clauseTrace: Trace[];
};
const key = (row: Row) => JSON.stringify([row.ruleId, row.object?.scope ?? null,
  row.object?.table ?? null, row.object?.id ?? null]);
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

function validExecution(entry: CheckRunFingerprint) {
  return !!entry && text(entry.ruleVersion) && text(entry.executor) &&
    isHash(entry.plan) && isHash(entry.evidence) && isHash(entry.review) &&
    (entry.tool === undefined || !!entry.tool && text(entry.tool.id) &&
      Number.isSafeInteger(entry.tool.version) && entry.tool.version > 0);
}

export function readComparisonBaseline(value: unknown, items: Pick<Trace, 'id' | 'source'>[]): ComparisonBaseline {
  const baseline = value as ComparisonBaseline | null;
  const originals = new Map(items.map(item => [item.id, item.source]));
  if (!baseline || !isHash(baseline.modelVersion) || !baseline.evidenceInventory ||
      !(baseline.evidenceInventory.revision === undefined || typeof baseline.evidenceInventory.revision === 'string') ||
      !Array.isArray(baseline.results) || baseline.results.length > 20_000 ||
      !Array.isArray(baseline.exportFeedback) || !Array.isArray(baseline.clauseTrace) || !baseline.clauseTrace.length ||
      baseline.clauseTrace.length > 500)
    throw new Error('复跑基线格式无效。请选择模型核查下载的基线报告。');
  const trace = new Map<string, Trace>();
  for (const row of baseline.clauseTrace) {
    const source = row && originals.get(row.id);
    if (!source || trace.has(row.id) || row.source?.document !== source.document ||
        row.source.locator !== source.locator || row.source.text !== source.text)
      throw new Error('基线的条款原文或工作表位置与当前条款不符。');
    if (row.execution !== undefined && !validExecution(row.execution))
      throw new Error('基线的规则、工具或证据指纹无效。');
    trace.set(row.id, row);
  }
  const seen = new Set<string>();
  for (const row of baseline.results) {
    if (!row || !trace.has(row.ruleId) || !text(row.ruleVersion) ||
        !['pass', 'fail', 'not-applicable', 'indeterminate'].includes(row.status) ||
        !(row.object === null || row.object && [row.object.scope, row.object.table, row.object.id].every(text)) ||
        (row.diagnosis !== undefined && (!Array.isArray(row.diagnosis?.blockers) ||
          !row.diagnosis.blockers.every(kind => typeof kind === 'string' && Object.hasOwn(blockerLabels, kind)))))
      throw new Error('基线含无法定位的条款或对象结果。');
    const execution = trace.get(row.ruleId)?.execution;
    if (execution && execution.ruleVersion !== row.ruleVersion)
      throw new Error('基线的规则版本与对象结果不符。');
    if (seen.has(key(row))) throw new Error('基线中的同一条款和作用域对象重复。');
    seen.add(key(row));
  }
  if (!baseline.exportFeedback.every(row => row && trace.has(row.ruleId)))
    throw new Error('基线的补证据建议无法关联到条款。');
  return baseline;
}

export function compareModelCheckReports(baseline: ComparisonBaseline, current: Report) {
  const priorTrace = new Map(baseline.clauseTrace.map(row => [row.id, row]));
  const priorEvaluated = new Set(baseline.results.map(row => row.ruleId));
  const runs = current.clauseTrace.filter(row => row.status === 'executed').map(row => {
    const before = priorTrace.get(row.id)?.execution;
    const after = row.execution;
    const newExecution = !priorEvaluated.has(row.id);
    const changes = before && after ? {
      plan: before.plan !== after.plan,
      evidence: before.evidence !== after.evidence,
      review: before.review !== after.review,
    } : null;
    return { ruleId: row.id, newExecution, before, after, changes };
  });
  const evaluated = new Set(runs.map(run => run.ruleId));
  const before = new Map(baseline.results.filter(row => evaluated.has(row.ruleId)).map(row => [key(row), row]));
  const after = new Map(current.results.map(row => [key(row), row]));
  const changes = [...new Set([...before.keys(), ...after.keys()])].flatMap(id => {
    const previous = before.get(id);
    const next = after.get(id);
    const beforeBlockers = [...new Set(previous?.diagnosis?.blockers)].sort();
    const afterBlockers = [...new Set(next?.diagnosis?.blockers)].sort();
    const comparableBlockers = previous?.status !== 'indeterminate' || previous.diagnosis !== undefined;
    const blockersChanged = comparableBlockers && JSON.stringify(beforeBlockers) !== JSON.stringify(afterBlockers);
    if (previous?.status === next?.status && !blockersChanged) return [];
    const row = (next ?? previous)!;
    return [{ ruleId: row.ruleId, ruleVersion: row.ruleVersion, object: row.object,
      before: previous?.status ?? null, after: next?.status ?? null, beforeBlockers, afterBlockers }];
  });
  return { version: 2, beforeModelVersion: baseline.modelVersion, afterModelVersion: current.modelVersion,
    beforeEvidenceRevision: baseline.evidenceInventory.revision, afterEvidenceRevision: current.evidenceInventory.revision,
    rules: [...evaluated], runs, changes };
}
