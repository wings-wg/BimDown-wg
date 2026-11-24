import { describe, expect, it } from 'vitest';
import { bindPalPlan, importSheetRules, importTextRule, type SheetRow } from './check-import.js';
import { HEIGHT, validatePalResponse } from './pal-plan.js';

function row(number: number, values: string[], formulaColumns: number[] = []): SheetRow {
  return { number, cells: new Map(values.map((value, index) => [index + 1, value])), formulaColumns: new Set(formulaColumns) };
}
const header = row(1, ['条款编号', '条款正文', '适用范围']);
const wording = '从本层楼面至楼上对应楼面，距离至多 3.45 m。';
const scope = '已复核的住宅楼层';
const source = (condition = wording, formulas: number[] = []) =>
  importSheetRules('synthetic.xlsx', '条款', [header, row(9, ['NEW-19', condition, scope], formulas)])[0];
const proposal = {
  id: 'NEW-19', kind: 'scalar', concept: HEIGHT, scope: 'project-storeys', operator: '<=', threshold: '3.45 m',
};
const validate = (candidate: unknown, item = source()) =>
  validatePalResponse(JSON.stringify({ rules: [candidate] }), [item.clause!])[0].plan;

describe('Excel to PAL rule import', () => {
  it('compiles typed and uploaded requirements via the same binder and preserves the typed wording', async () => {
    const item = await importTextRule(wording);
    expect(item.source.text).toBe(wording);
    expect((await importTextRule(` ${wording} `)).id).toBe(item.id);
    expect((await importTextRule('从本层楼面至楼上对应楼面，距离至多 3.46 m。')).id).not.toBe(item.id);
    expect(bindPalPlan(item, validate({ ...proposal, id: item.id }, item)).rule)
      .toMatchObject({ id: item.id, reviewed: false, threshold: 3.45 });
  });

  it('reads unfamiliar wording and binds a grounded prediction as an unreviewed rule', () => {
    const item = source();
    expect(item.clause?.condition).toBe(wording);
    expect(item.rule).toBeUndefined();
    const bound = bindPalPlan(item, validate(proposal));
    expect(bound.rule).toMatchObject({ source: { locator: '条款 · 第 9 行' }, applicability: scope, reviewed: false,
      id: 'NEW-19', threshold: 3.45, operator: '<=', targetTable: 'level' });
  });

  it('rejects formulas, unquoted or partial numbers, conflicts, unknown tools and extra fields', () => {
    expect(source(wording, [2]).clause).toBeUndefined();
    for (const [candidate, input] of [
      [{ ...proposal, threshold: '2 m' }, source()],
      [proposal, source('从本层楼面到上一层不超过 13.45 m。')],
      [proposal, source('楼层高度至少 3.00 m，也写作至少 3.45 m。')],
      [{ ...proposal, kind: 'script' }, source()],
      [{ ...proposal, reviewed: true, source: 'fake' }, source()],
      [{ ...proposal, scope: 'all-model-rooms' }, source()],
    ] as const) expect(validate(candidate, input).kind).toBe('blocked');
    expect(validatePalResponse(JSON.stringify({ rules: [proposal, proposal] }), [source().clause!])[0].plan.kind)
      .toBe('blocked');
  });

  it('normalizes original units and a local exception across independently written clauses', () => {
    const item = source('净高常规至少 2700 mm。局部不得小于 2.3 米；低于 2700 mm 的面积不得超过使用面积的 25%。');
    const result = bindPalPlan(item, validate({ id: item.id, kind: 'clear-height-with-local-exception',
      scope: 'ordinary-residential-rooms', nominalHeight: '2700 mm', minimumHeight: '2.3 米', maxLowAreaFraction: '25%' }, item));
    expect(result.clearHeightRule).toMatchObject({ reviewed: false, nominalHeight: 2.7, minimumHeight: 2.3,
      maxLowAreaFraction: { numerator: 25, denominator: 100 } });
  });
});
