import { describe, it, expect } from 'vitest';
import { executeRule, diagnose, type EngineeringRule, type EngineeringDatum } from './index.js';
const rule: EngineeringRule = { id: 'demo', version: '1', reviewed: true,
  source: { document: 'synthetic', locator: 'case-1', text: 'Reviewed room usable area at least 5 m2' },
  applicability: 'Reviewer-confirmed synthetic bedroom', concept: 'room.usable-area', unit: 'm2', operator: '>=', threshold: 5 };
const datum: EngineeringDatum = { object: { scope: 'lv-1', table: 'space', id: 'sp-1' }, concept: 'room.usable-area', unit: 'm2', value: 5, source: 'reviewed measurement', modelVersion: 'fixture-v1', confirmed: true };
describe('engineering contract MVP', () => {
  it('checks threshold boundaries and unit invariance', () => {
    expect(executeRule(rule, datum).status).toBe('pass');
    expect(executeRule(rule, { ...datum, value: 4.99 }).status).toBe('fail');
    expect(executeRule(rule, { ...datum, value: 5000000, unit: 'mm2' }).status).toBe('pass');
  });
  it('blocks absent, semantically incompatible and unreviewed data', () => {
    expect(diagnose(rule).status).toBe('missing-data');
    expect(diagnose(rule, { ...datum, concept: 'room.gross-area' }).status).toBe('semantic-mismatch');
    expect(executeRule({ ...rule, reviewed: false }, datum).status).toBe('indeterminate');
    expect(executeRule(rule, { ...datum, confirmed: false }).status).toBe('indeterminate');
  });
  it('rejects malformed rules and unsupported dimensions', () => {
    expect(() => executeRule({ ...rule, threshold: NaN }, datum)).toThrow(/contract/);
    expect(diagnose(rule, { ...datum, unit: 'm' }).status).toBe('unsupported');
    expect(diagnose(rule, { ...datum, value: NaN }).status).toBe('missing-data');
  });
});
