import { describe, expect, it } from 'vitest';
import { checkClearHeight, type ClearHeightRule } from './clear-height.js';

const rule: ClearHeightRule = {
  id: 'synthetic-local-clearance', version: '1', reviewed: true,
  kind: 'clear-height-with-local-exception',
  source: { document: 'synthetic', locator: 'example', text: 'Test local clearance with a limited low area' },
  applicability: 'ordinary rooms in the synthetic project',
  nominalHeight: 2.6, minimumHeight: 2.2, maxLowAreaFraction: { numerator: 1, denominator: 3 },
};
const datum = { minimumHeight: 2.2, usableArea: 12, lowArea: 4, belowHeight: 2.6, source: 'Synthetic section and plan' };

describe('clear height with a local exception', () => {
  it('accepts exact lower height and area limits without rounding to a percent', () => {
    expect(checkClearHeight(rule, datum).status).toBe('pass');
    expect(checkClearHeight(rule, { ...datum, usableArea: 0.3, lowArea: 0.1 }).status).toBe('pass');
    expect(checkClearHeight(rule, { ...datum, minimumHeight: 2.6, lowArea: 0 }).status).toBe('pass');
  });

  it('reports minimum-height and area violations independently', () => {
    expect(checkClearHeight(rule, { ...datum, minimumHeight: 2.19 })).toMatchObject({
      status: 'fail', reason: '最低净高低于局部下限',
    });
    expect(checkClearHeight(rule, { ...datum, lowArea: 4.001 })).toMatchObject({
      status: 'fail', reason: '低净高面积占比超过限值',
    });
  });

  it('blocks mismatched thresholds, missing evidence and inconsistent area or height', () => {
    for (const evidence of [{ ...datum, belowHeight: 2.7 }, { ...datum, source: '' }, { ...datum, lowArea: undefined },
      { ...datum, lowArea: 13 }, { ...datum, usableArea: 0 }, { ...datum, minimumHeight: 2.65 }])
      expect(checkClearHeight(rule, evidence).status).toBe('indeterminate');
    expect(checkClearHeight({ ...rule, reviewed: false }, datum).status).toBe('indeterminate');
  });
});
