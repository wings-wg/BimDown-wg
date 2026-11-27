import { describe, expect, it } from 'vitest';
import { bindPalPlan, importJsonRules, importTextRule, type CheckItem } from './check-import.js';
import { readCheckLevels, runModelCheck } from './check-model.js';
import { validatePalResponse, type PalClause } from './pal-plan.js';
import { verifyCandidatePackage } from './pal-candidate-package.js';
import { stairHeadroomBranches } from './component-minimum.js';

const entry: PalClause = {
  id: 'GG-07', target: '楼梯净空', attribute: '梯段与平台处净高',
  condition: '梯段净高低于 2.200m 或 平台净高低于 2.000m 判FAIL', limit: '梯段不少于 2.200m；平台不少于 2.000m',
  reference: '验收用条款来源', applicability: '含梁、风管、管线穿越处', note: '模型须含结构与风管，否则漏判',
};
const source = { document: '合成规则表', locator: '规则 · 第 2 行', text: Object.values(entry).slice(1).join('；') };
const proposal = { id: entry.id, kind: 'component-minimum', profile: 'stair-headroom',
  thresholds: { flight: '2.200m', landing: '2.000m' } };
const compile = (clause: PalClause, candidate: object = proposal) =>
  validatePalResponse(JSON.stringify({ rules: [candidate] }), [clause])[0].plan;
const fromSheet = () => bindPalPlan({ id: entry.id, title: entry.target, clause: entry, source }, compile(entry));

const flight = { scope: 'lv-1', table: 'stair_run', id: 'c-1' };
const flight2 = { scope: 'lv-2', table: 'stair_run', id: 'c-1' };
const landing = { scope: 'lv-1', table: 'stair_landing', id: 'c-1' };
const bareStair = { scope: 'lv-1', table: 'stair', id: 's-1' };
const notApplicable = { scope: 'lv-2', table: 'stair', id: 's-1' };
const fixture = () => {
  const files = new Map([
    ['project_metadata.json', JSON.stringify({ units: 'm', engineering_revision: 'stair-v1' })],
    ['global/level.csv', 'id,name,elevation\nlv-1,F1,0\nlv-2,F2,3'],
    ['lv-1/stair.csv', 'id,name,width\ns-1,一层楼梯,1.3'],
    ['lv-2/stair.csv', 'id,name,width\ns-1,二层容器,1.3'],
    ['lv-1/stair_run.csv', 'id,name,host_id\nc-1,一层梯段,s-1'],
    ['lv-2/stair_run.csv', 'id,name,host_id\nc-1,二层梯段,s-1'],
    ['lv-1/stair_landing.csv', 'id,name,host_id\nc-1,一层平台,s-1'],
  ]);
  const datum = (object: typeof flight, concept: string, value: number, unit = 'mm') =>
    ({ object, concept, value, unit, confirmed: true, source: '已检查净空剖面', measurementGroup: '剖面测点 A' });
  const evidence = {
    version: 1, modelRevision: 'stair-v1',
    measurements: [datum(flight, stairHeadroomBranches.flight.concept, 2200),
      datum(landing, stairHeadroomBranches.landing.concept, 1.99, 'm'),
      datum(flight2, stairHeadroomBranches.flight.concept, 2300),
      datum(bareStair, stairHeadroomBranches.landing.concept, 2800)],
    applicability: [flight, landing, flight2, bareStair, notApplicable].map(object => ({
      object, ruleId: entry.id, ruleVersion: 'pal-1', applicability: entry.applicability,
      decision: object === notApplicable ? 'does-not-apply' : 'applies', source: '楼梯归属与适用性复核',
    })),
    stairHeadroomCoverage: [flight, landing, flight2, bareStair].map(object => ({
      object, location: '剖面测点 A', confirmed: true, coversStructure: true, coversServices: object !== flight2, source: '结构风管及管线复核',
    })),
  };
  return { files, evidence };
};
async function run(files: Map<string, string>, items: CheckItem[] = [fromSheet()]) {
  const ds = { fetchText: async (path: string) => files.get(path) ?? null };
  const { raw } = await readCheckLevels(ds);
  return runModelCheck(ds, items, new Map(), raw);
}

describe('component minimum: stair headroom', () => {
  it('validates branch-specific quotes and rejects omitted, swapped or conflicting branches and exceptions', () => {
    const { plans } = verifyCandidatePackage({ version: 1, origin: '合成测试',
      entries: [{ clause: entry, proposal, source, verification: [] }] }, []);
    expect(plans[0].plan).toMatchObject({ kind: 'component-minimum', thresholds: { flight: 2.2, landing: 2 } });
    for (const candidate of [
      { ...proposal, thresholds: { flight: '2.000m', landing: '2.200m' } },
      { ...proposal, thresholds: { flight: '2.200m' } },
      { ...proposal, ignoredExceptions: [] },
    ]) expect(compile(entry, candidate)).toMatchObject({ kind: 'blocked', gap: 'clarification' });
    expect(compile({ ...entry, limit: '梯段不少于 2.300m；平台不少于 2.000m' }))
      .toMatchObject({ kind: 'blocked', reason: expect.stringContaining('梯段') });
    expect(compile({ ...entry, note: '屋面楼梯可按 1.90m' })).toMatchObject({ kind: 'blocked', gap: 'clarification' });
    expect(compile({ ...entry, condition: '梯段净高低于 2.200m 判FAIL' })).toMatchObject({ kind: 'blocked' });
  });

  it('shares a rule profile across unseen text and permits reviewed JSON round trips', async () => {
    const other = await importTextRule('楼梯平台净高不得小于 2050 毫米，楼梯梯段净空至少 2.10 米。');
    const plan = compile(other.clause!, { ...proposal, id: other.id, thresholds: { flight: '2.10 米', landing: '2050 毫米' } });
    const rule = bindPalPlan(other, plan).componentMinimumRule!;
    expect(rule.thresholds).toEqual({ flight: 2.10, landing: 2.05 });
    const json = (reviewed: boolean) => JSON.stringify({ rules: [{ ...rule, reviewed }] });
    expect(importJsonRules(json(false))[0].componentMinimumRule).toBeUndefined();
    expect(importJsonRules(json(true))[0].componentMinimumRule).toMatchObject({ ...rule, reviewed: true });
  });

  it('checks exact limits, scoped short IDs and evidence provenance for each component', async () => {
    const { files, evidence } = fixture();
    files.set('engineering_evidence.json', JSON.stringify(evidence));
    const report = await run(files);
    expect(report.pending).toHaveLength(0);
    expect(report.clauseTrace[0].execution?.executor).toBe('component-minimum@1');
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ object: flight, status: 'pass', evidence: expect.objectContaining({
        normalizedValue: 2.2, inputUnit: 'mm', inputValue: 2200, threshold: 2.2 }),
        headroomCoverage: expect.objectContaining({ location: '剖面测点 A' }) }),
      expect.objectContaining({ object: landing, status: 'fail', componentMinimum: { branch: 'landing', threshold: 2 } }),
      expect.objectContaining({ object: flight2, status: 'indeterminate', diagnosis: { blockers: ['confirm-stair-obstructions'] } }),
      expect.objectContaining({ object: bareStair, status: 'indeterminate', diagnosis: { blockers: ['confirm-measurement'] } }),
      expect.objectContaining({ object: notApplicable, status: 'not-applicable' }),
    ]));
    expect(report.exportFeedback[0].files).toContain('<楼层>/stair_landing.csv');
  });

  it('keeps missing, duplicate, stale and repeated-instance evidence indeterminate', async () => {
    const { files, evidence } = fixture();
    const missing = await run(new Map([...files].filter(([path]) => !path.includes('/stair'))));
    expect(missing.results).toMatchObject([{ object: null, status: 'indeterminate', diagnosis: { blockers: ['missing-object'] } }]);
    files.set('engineering_evidence.json', JSON.stringify({ ...evidence, modelRevision: 'old' }));
    expect((await run(files)).results.every(row => row.status === 'indeterminate')).toBe(true);
    evidence.measurements[1].measurementGroup = '另一剖面测点';
    evidence.stairHeadroomCoverage.push(evidence.stairHeadroomCoverage[0]);
    files.set('engineering_evidence.json', JSON.stringify(evidence));
    files.set('lv-2/stair.csv', 'id,name,multistory_top_level_id\ns-1,重复楼梯,lv-3');
    const conflicts = await run(files);
    expect(conflicts.results).toContainEqual(expect.objectContaining({ object: flight, diagnosis: { blockers: ['input-conflict'] } }));
    expect(conflicts.results).toContainEqual(expect.objectContaining({ object: landing, diagnosis: { blockers: ['input-conflict'] },
      reason: expect.stringContaining('同一测点') }));
    expect(conflicts.results).toContainEqual(expect.objectContaining({ object: flight2, diagnosis: { blockers: ['confirm-stair-component'] } }));
  });
});
