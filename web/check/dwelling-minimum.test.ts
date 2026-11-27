import { describe, expect, it } from 'vitest';
import { bindPalPlan, importJsonRules, importTextRule } from './check-import.js';
import { readCheckLevels, runModelCheck } from './check-model.js';
import { validatePalResponse, type PalClause } from './pal-plan.js';
import { verifyCandidatePackage } from './pal-candidate-package.js';
import { compareModelCheckReports } from './report-comparison.js';
import { evaluateDwellingMinimum } from './core/dwelling-count.js';

const clause: PalClause = {
  id: 'ZT-08', target: '无障碍住房', attribute: '户类型属性 AccessibleUnit',
  condition: '无障碍住房数 低于 max(1, 总户数 x 2%) 判FAIL',
  limit: '不低于总户数 2% 且每个项目不少于 1 套', reference: '验收用配建来源',
  applicability: '新建住宅小区', note: '户数与套型属性须逐户建模，不得整单元复制遗漏',
};
const source = { document: '合成规则表', locator: '规则 · 第 2 行', text: Object.values(clause).slice(1).join('；') };
const proposal = { id: clause.id, kind: 'dwelling-count-minimum', profile: 'accessible-dwellings', minimumCount: '1', minimumFraction: '2%' };
const compile = (input = clause, candidate = proposal) =>
  validatePalResponse(JSON.stringify({ rules: [candidate] }), [input])[0].plan;
const item = bindPalPlan({ id: clause.id, title: clause.target, clause, source }, compile());
const projectRef = { scope: 'global', table: 'project', id: 'Z-1' };

function fixture(total: number, accessible: number) {
  const evidence = {
    version: 1, modelRevision: 'housing-v1', measurements: [],
    applicability: [{ object: projectRef, ruleId: clause.id, ruleVersion: 'pal-1', applicability: clause.applicability,
      decision: 'applies', source: '新建住宅项目适用性复核',
      dwellingCountBasis: { minimumCount: 1, minimumFraction: { numerator: 1, denominator: 50 }, source: '合成项目批准条件' } }],
    dwellingInventory: {
      projectId: projectRef.id, scope: 'whole-residential-project', complete: true, expectedCount: total,
      scopeSource: '合成审批总平面', countSource: '独立复核住宅总表',
      dwellings: Array.from({ length: total }, (_, index) => ({ building: index % 2 ? 'B2' : 'B1',
        id: `H-${Math.floor(index / 2) + 1}`, accessible: index < accessible, confirmed: true, source: '经复核套型表' })),
    },
  };
  async function run() {
    const files = new Map([
      ['project_metadata.json', JSON.stringify({ units: 'm', project_number: projectRef.id, engineering_revision: 'housing-v1' })],
      ['engineering_evidence.json', JSON.stringify(evidence)],
    ]);
    const ds = { fetchText: async (path: string) => files.get(path) ?? null };
    const { raw } = await readCheckLevels(ds);
    return runModelCheck(ds, [item], new Map(), raw);
  }
  return { evidence, run };
}

describe('project dwelling count minimum', () => {
  it('compiles the Excel shape and independently validates both limits, scope and direction', () => {
    const { plans } = verifyCandidatePackage({ version: 1, origin: '回放测试',
      entries: [{ clause, source, proposal, verification: [] }] }, []);
    expect(plans[0].plan).toMatchObject({ kind: 'dwelling-count-minimum', minimumCount: 1,
      minimumFraction: { numerator: 2, denominator: 100 } });
    for (const changed of [
      { ...clause, limit: '不低于总户数 3% 且每个项目不少于 1 套' },
      { ...clause, applicability: '按分期住宅项目' },
      { ...clause, condition: '无障碍住房数 高于 max(1, 总户数 x 2%) 判FAIL' },
      { ...clause, note: '小于 50 户可不配建' },
    ]) expect(compile(changed)).toMatchObject({ kind: 'blocked', gap: 'clarification' });
    expect(compile(clause, { ...proposal, minimumCount: '2' })).toMatchObject({ kind: 'blocked' });
  });

  it('reuses the rule structure for unseen thresholds and preserves the review gate on JSON import', async () => {
    const input = await importTextRule('新建住宅项目的无障碍住房不少于总户数的 2.5%，且每个项目至少 2 套。');
    const plan = compile(input.clause!, { ...proposal, id: input.id, minimumCount: '2', minimumFraction: '2.5%' });
    const rule = bindPalPlan(input, plan).dwellingMinimumRule;
    expect(rule).toMatchObject({ minimumCount: 2, minimumFraction: { numerator: 25, denominator: 1000 } });
    expect(importJsonRules(JSON.stringify({ rules: [rule] }))[0].dwellingMinimumRule).toBeUndefined();
    expect(importJsonRules(JSON.stringify({ rules: [{ ...rule, reviewed: true }] }))[0].dwellingMinimumRule?.reviewed).toBe(true);
  });

  it('uses exact proportional rounding and keeps both the proportion and minimum count', async () => {
    const min = { minimumCount: 2, minimumFraction: { numerator: 2, denominator: 100 } };
    expect(evaluateDwellingMinimum(25, 1, min)).toMatchObject({ required: 2, shortfall: 1, proportionalMinimum: 1 });
    const below = await fixture(51, 1).run();
    expect(below.results[0]).toMatchObject({ object: projectRef, resultScope: 'project', status: 'fail',
      dwellingCount: { total: 51, accessible: 1, required: 2, shortfall: 1, basisSource: '合成项目批准条件' } });
    expect(below.evidenceInventory.dwellingInventory?.dwellings).toHaveLength(51);
    const exactly = await fixture(50, 1).run();
    expect(exactly.results[0]).toMatchObject({ status: 'pass', dwellingCount: { required: 1, shortfall: 0 } });
    const comparison = compareModelCheckReports(below, exactly);
    expect(comparison.changes).toMatchObject([{ object: projectRef, before: 'fail', after: 'pass' }]);
    expect(comparison.runs[0].changes).toMatchObject({ plan: false, evidence: true, review: false });
  });

  it('withholds conclusions on duplicate, incomplete, conflicting and stale evidence', async () => {
    const { evidence, run } = fixture(5, 3);
    const blocker = async (kind: string) => {
      const result = await run();
      expect(result.results[0]).toMatchObject({ status: 'indeterminate', diagnosis: { blockers: [kind] } });
      expect(result.results[0]).not.toHaveProperty('dwellingCount');
    };
    const { dwellings } = evidence.dwellingInventory;
    const last = dwellings.pop()!;
    await blocker('confirm-dwelling-inventory');
    dwellings.push(dwellings[0]);
    await blocker('input-conflict');
    dwellings[4] = { ...last, confirmed: false };
    await blocker('confirm-dwelling-classification');
    dwellings[4] = last;
    evidence.applicability[0].dwellingCountBasis.minimumCount = 2;
    await blocker('input-conflict');
    evidence.applicability[0].decision = 'does-not-apply';
    expect((await run()).results[0].status).toBe('not-applicable');
    evidence.modelRevision = 'other';
    await blocker('invalid-evidence');
  });
});
