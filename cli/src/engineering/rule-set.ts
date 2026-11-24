import { executeRule, validateRule, type EngineeringDatum, type EngineeringRule } from './index.js';

export interface ScalarRuleSet {
  rules: Array<EngineeringRule & { targetTable: string }>;
}

export interface ScalarEvidenceSet {
  modelVersion: string;
  targets: Array<{
    object: EngineeringDatum['object'];
    applicability: Array<{
      ruleId: string;
      ruleVersion: string;
      decision: 'applies' | 'does-not-apply';
      source: string;
    }>;
    measurements: Array<Omit<EngineeringDatum, 'object' | 'modelVersion'>>;
  }>;
}

const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function uniqueIndex<T>(items: T[], key: (item: T) => string, label: string): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (index.has(id)) throw new Error(`Duplicate ${label}: ${id}`);
    index.set(id, item);
  }
  return index;
}

/** Check the supplied inventory against versioned rules using explicitly confirmed applicability. */
export function runScalarRuleSet(ruleSet: ScalarRuleSet, evidenceSet: ScalarEvidenceSet) {
  if (!Array.isArray(ruleSet?.rules) || !ruleSet.rules.length)
    throw new Error('Expected a non-empty rules array');
  if (!hasText(evidenceSet?.modelVersion) || !Array.isArray(evidenceSet.targets))
    throw new Error('Expected a model version and a target inventory');

  const rules = uniqueIndex(ruleSet.rules, rule => {
    validateRule(rule);
    if (!hasText(rule.targetTable)) throw new Error('Expected a target table for each scalar rule');
    return rule.id;
  }, 'rule ID');

  const targets = evidenceSet.targets.map(target => {
    if (!target?.object || ![target.object.scope, target.object.table, target.object.id].every(hasText) ||
        !Array.isArray(target.applicability) || !Array.isArray(target.measurements))
      throw new Error('Expected a scoped target with applicability and measurements arrays');
    const decisions = uniqueIndex(target.applicability, item => {
      if (!item || ![item.ruleId, item.ruleVersion, item.source].every(hasText) ||
          !['applies', 'does-not-apply'].includes(item.decision))
        throw new Error('Invalid applicability evidence');
      return JSON.stringify([item.ruleId, item.ruleVersion]);
    }, 'applicability decision');
    const measurements = uniqueIndex(target.measurements, item => {
      if (!item || !hasText(item.concept) || typeof item.source !== 'string' || typeof item.confirmed !== 'boolean')
        throw new Error('Invalid scalar measurement evidence');
      return item.concept;
    }, 'measurement concept');
    return { object: target.object, decisions, measurements };
  });
  uniqueIndex(targets, ({ object }) => JSON.stringify([object.scope, object.table, object.id]), 'scoped target');

  const results = Array.from(rules.values(), rule => {
    const base = { ruleId: rule.id, ruleVersion: rule.version, source: rule.source,
      targetTable: rule.targetTable, applicability: rule.applicability, concept: rule.concept,
      threshold: rule.threshold, unit: rule.unit, operator: rule.operator };
    const matchingTargets = targets.filter(target => target.object.table === rule.targetTable);
    if (!matchingTargets.length) return [{ ...base, object: null, status: 'indeterminate' as const,
      diagnostic: { status: 'missing-data', reason: 'No supplied target for the rule table' } }];

    return matchingTargets.map(({ object, decisions, measurements }) => {
      if (!rule.reviewed) return { ...base, object, ...executeRule(rule) };
      const decision = decisions.get(JSON.stringify([rule.id, rule.version]));
      if (!decision) return { ...base, object, status: 'indeterminate' as const,
        diagnostic: { status: 'clarification-required', reason: 'Applicability for this rule revision requires confirmation' } };
      if (decision.decision === 'does-not-apply')
        return { ...base, object, status: 'not-applicable' as const, applicabilitySource: decision.source };

      const measurement = measurements.get(rule.concept);
      const datum = measurement && { ...measurement, object, modelVersion: evidenceSet.modelVersion };
      return { ...base, object, applicabilitySource: decision.source, ...executeRule(rule, datum) };
    });
  }).flat();
  return { version: 1, modelVersion: evidenceSet.modelVersion, results };
}
