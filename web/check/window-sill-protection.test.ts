import { describe, expect, it } from 'vitest';
import { bindPalPlan, importJsonRules, importTextRule } from './check-import.js';
import { readCheckLevels, runModelCheck } from './check-model.js';
import { validatePalResponse, type PalClause } from './pal-plan.js';
import { verifyCandidatePackage } from './pal-candidate-package.js';
import { compareModelCheckReports } from './report-comparison.js';
import { WINDOW_SILL_HEIGHT } from './conditional-requirement.js';

const clause: PalClause = {
  id: 'JT-11', target: '外窗', attribute: '窗台净高 + 防护措施属性',
  condition: '窗台净高 低于 0.900m 且 无防护 判FAIL', limit: '窗台低于 0.900m 的部位应设防护措施',
  reference: '合成验收资料', applicability: '外窗、落地窗、飘窗', note: '飘窗以可踏面起算高度',
};
const source = { document: '合成规则表', locator: '规则 · 第 2 行', text: Object.values(clause).slice(1).join('；') };
const proposal = { id: clause.id, kind: 'conditional-requirement', profile: 'window-sill-protection', sillThreshold: '0.900m' };
const compile = (input = clause, candidate: object = proposal) =>
  validatePalResponse(JSON.stringify({ rules: [candidate] }), [input])[0].plan;
const item = bindPalPlan({ id: clause.id, title: clause.target, clause, source }, compile());
const window = (id: string, scope = 'lv-1') => ({ scope, table: 'window', id });
const equal = window('w-1');
const absent = window('w-1', 'lv-2');
const uncertain = window('w-2');
const protectedWindow = window('w-3');
const wrongBasis = window('w-4');
const excluded = window('w-5');
const missingHeight = window('w-6');

function fixture() {
  const evidence = {
    version: 1, modelRevision: 'window-v1',
    measurements: [[equal, 900, 'finished-floor'], [absent, 0, 'finished-floor'],
      [uncertain, 899, 'finished-floor'], [protectedWindow, 850, 'walkable-surface'], [wrongBasis, 950, 'finished-floor']]
      .map(([object, value, windowSillBasis]) => ({ object, concept: WINDOW_SILL_HEIGHT, value, windowSillBasis, unit: 'mm',
        confirmed: true, source: '已复核剖面', measurementGroup: '室内窗台 A' })),
    applicability: [equal, absent, uncertain, protectedWindow, wrongBasis, excluded, missingHeight].map(object => ({
      object, ruleId: clause.id, ruleVersion: 'pal-1', applicability: clause.applicability,
      windowKind: object === absent ? 'full-height' : object === wrongBasis || object === protectedWindow ? 'bay' : 'ordinary',
      decision: object === excluded ? 'does-not-apply' : 'applies', source: '外窗适用性复核',
    })),
    windowGuards: [absent, protectedWindow].map(object => ({
      object, provided: object === protectedWindow, confirmed: true, location: '室内窗台 A', source: '防护节点复核',
    })),
  };
  const files = new Map([
    ['project_metadata.json', JSON.stringify({ units: 'm', engineering_revision: 'window-v1' })],
    ['global/level.csv', 'id,name,elevation\nlv-1,F1,0\nlv-2,F2,3'],
    ['lv-1/window.csv', 'id,number,base_offset\nw-1,窗1,1.20\nw-2,窗2,1.20\nw-3,窗3,1.20\nw-4,窗4,1.20\nw-5,窗5,1.20\nw-6,窗6,1.20'],
    ['lv-2/window.csv', 'id,number\nw-1,二层窗1'],
  ]);
  const run = async (includeEvidence = true) => {
    const ds = { fetchText: async (path: string) => path === 'engineering_evidence.json'
      ? includeEvidence ? JSON.stringify(evidence) : null : files.get(path) ?? null };
    const { raw } = await readCheckLevels(ds);
    return runModelCheck(ds, [item], new Map(), raw);
  };
  return { evidence, files, run };
}

describe('conditional sill protection', () => {
  it('requires both the threshold and the original conditional requirement, including strict comparison', () => {
    const { plans } = verifyCandidatePackage({ version: 1, origin: '合成测试',
      entries: [{ clause, proposal, source, verification: [] }] }, []);
    expect(plans[0].plan).toMatchObject({ kind: proposal.kind, sillThreshold: 0.9 });
    for (const changed of [
      { ...clause, limit: '窗台低于 0.800m 的部位应设防护措施' },
      { ...clause, condition: '窗台净高不高于 0.900m 且无防护判FAIL' },
      { ...clause, condition: '窗台净高低于 0.900m 判FAIL' },
      { ...clause, note: '固定窗除外' },
    ]) expect(compile(changed)).toMatchObject({ kind: 'blocked', gap: 'clarification' });
    expect(compile(clause, { ...proposal, sillThreshold: '900mm' })).toMatchObject({ kind: 'blocked' });
    expect(compile(clause, { id: clause.id, kind: 'scalar', concept: 'storey.architectural-height', scope: 'project-storeys',
      operator: '>=', threshold: '0.900m' })).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('防护') });
  });

  it('supports unseen thresholds through the same rule profile and requires review for a JSON round trip', async () => {
    const text = await importTextRule('住宅外窗窗台净高低于 875 毫米时必须设置防护措施。');
    const candidate = compile(text.clause!, { ...proposal, id: text.id, sillThreshold: '875 毫米' });
    const rule = bindPalPlan(text, candidate).conditionalRequirementRule;
    expect(rule).toMatchObject({ sillThreshold: 0.875, applicability: '外窗' });
    expect(importJsonRules(JSON.stringify({ rules: [rule] }))[0].conditionalRequirementRule).toBeUndefined();
    expect(importJsonRules(JSON.stringify({ rules: [{ ...rule, reviewed: true }] }))[0].conditionalRequirementRule?.reviewed).toBe(true);
  });

  it('evaluates equality, zero height, explicit presence and absence, and pending evidence across scopes', async () => {
    const { run } = fixture();
    const report = await run();
    expect(report.clauseTrace[0].execution?.executor).toBe('conditional-requirement@1');
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ object: equal, status: 'pass', windowProtection: { threshold: 0.9, triggered: false,
        sill: expect.objectContaining({ valueM: 0.9, inputValue: 900 }), applicabilitySource: expect.any(String) } }),
      expect.objectContaining({ object: absent, status: 'fail', windowProtection: expect.objectContaining({
        guard: expect.objectContaining({ provided: false }), sill: expect.objectContaining({ valueM: 0 }) }) }),
      expect.objectContaining({ object: protectedWindow, status: 'pass', windowProtection: expect.objectContaining({
        triggered: true, guard: expect.objectContaining({ provided: true }) }) }),
      expect.objectContaining({ object: uncertain, status: 'indeterminate', diagnosis: { blockers: ['confirm-window-guard'] } }),
      expect.objectContaining({ object: wrongBasis, status: 'indeterminate', diagnosis: { blockers: ['confirm-window-sill'] } }),
      expect.objectContaining({ object: missingHeight, status: 'indeterminate', diagnosis: { blockers: ['confirm-window-sill'] } }),
      expect.objectContaining({ object: excluded, status: 'not-applicable' }),
    ]));
    expect(report.exportFeedback[0].fields).toContain(WINDOW_SILL_HEIGHT);
    const withoutEvidence = await run(false);
    expect(withoutEvidence.results.every(row => row.status === 'indeterminate')).toBe(true);
    const comparison = compareModelCheckReports(withoutEvidence, report);
    expect(comparison.runs[0].changes).toEqual({ plan: false, evidence: true, review: false });
    expect(comparison.changes).toContainEqual(expect.objectContaining({ object: absent, before: 'indeterminate', after: 'fail' }));
  });

  it('rejects mismatched guard locations, duplicate and stale data', async () => {
    const { run, evidence, files } = fixture();
    evidence.windowGuards[0].location = '不同窗台';
    evidence.windowGuards.push(evidence.windowGuards[1]);
    const conflicts = await run();
    for (const object of [absent, protectedWindow]) expect(conflicts.results).toContainEqual(expect.objectContaining({
      object, status: 'indeterminate', diagnosis: { blockers: ['input-conflict'] },
    }));
    expect(conflicts.results.find(row => row.object?.id === equal.id && row.object.scope === equal.scope)?.status).toBe('pass');
    evidence.modelRevision = 'stale-export';
    expect((await run()).results.every(row => row.diagnosis?.blockers.includes('invalid-evidence'))).toBe(true);
    files.delete('lv-1/window.csv');
    files.delete('lv-2/window.csv');
    expect((await run()).results).toMatchObject([{ object: null, status: 'indeterminate', diagnosis: { blockers: ['missing-object'] } }]);
  });
});
