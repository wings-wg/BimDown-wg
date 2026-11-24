import { describe, expect, it } from 'vitest';
import { runScalarRuleSet, type ScalarEvidenceSet, type ScalarRuleSet } from './rule-set.js';

const rule: ScalarRuleSet['rules'][number] = {
  id: 'synthetic-height', version: '1', reviewed: true, targetTable: 'level',
  source: { document: 'synthetic', locator: 'height', text: 'Synthetic height threshold' },
  applicability: 'Confirmed synthetic residential storeys',
  concept: 'storey.architectural-height', unit: 'm', operator: '>=', threshold: 3,
};
const target: ScalarEvidenceSet['targets'][number] = {
  object: { scope: 'building-a', table: 'level', id: 'lv-1' },
  applicability: [{ ruleId: rule.id, ruleVersion: rule.version, decision: 'applies', source: 'Fixture review' }],
  measurements: [{ concept: rule.concept, value: 3000, unit: 'mm', source: 'Fixture measurement', confirmed: true }],
};
const run = (rules: ScalarRuleSet['rules'], targets: ScalarEvidenceSet['targets'] = [target]) =>
  runScalarRuleSet({ rules }, { modelVersion: 'fixture-v1', targets }).results;

describe('scalar rule set', () => {
  it('evaluates different configured thresholds using the same measurement', () => {
    const variant = { ...rule, id: 'stricter-height', threshold: 3.1 };
    const applicability = [...target.applicability, { ...target.applicability[0], ruleId: variant.id }];
    expect(run([rule, variant], [{ ...target, applicability }])).toMatchObject([
      { status: 'pass', evidence: { normalizedValue: 3, threshold: 3, modelVersion: 'fixture-v1' } },
      { status: 'fail', evidence: { normalizedValue: 3, threshold: 3.1, modelVersion: 'fixture-v1' } },
    ]);
  });

  it('requires applicability for the current revision and confirmed evidence of the right concept', () => {
    expect(run([{ ...rule, version: '2' }])[0]).toMatchObject({
      status: 'indeterminate', diagnostic: { status: 'clarification-required' },
    });
    expect(run([rule], [{ ...target, measurements: [{ ...target.measurements[0], concept: 'room.clear-height' }] }])[0])
      .toMatchObject({ status: 'indeterminate', diagnostic: { status: 'missing-data' } });
    const excluded = { ...target, applicability: [{ ...target.applicability[0], decision: 'does-not-apply' as const }] };
    expect(run([rule], [excluded])[0].status).toBe('not-applicable');
    expect(run([{ ...rule, reviewed: false }], [excluded])[0].status).toBe('indeterminate');
    expect(run([rule], [])[0].status).toBe('indeterminate');
  });

  it('accepts repeated short IDs in different scopes and rejects ambiguous evidence', () => {
    const otherScope = { ...target, object: { ...target.object, scope: 'building-b' } };
    expect(run([rule], [target, otherScope]).map(item => item.object?.scope)).toEqual(['building-a', 'building-b']);
    expect(() => run([rule], [target, target])).toThrow('Duplicate scoped target');
    expect(() => run([rule, rule])).toThrow('Duplicate rule ID');
    expect(() => run([rule], [{ ...target, measurements: [...target.measurements, ...target.measurements] }]))
      .toThrow('Duplicate measurement concept');
  });
});
