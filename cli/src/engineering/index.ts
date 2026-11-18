/** MVP contracts: candidate rules cannot execute until explicitly reviewed. */
export interface EngineeringRule {
  id: string;
  version: string;
  reviewed: boolean;
  source: { document: string; locator: string; text: string };
  applicability: string;
  concept: string;
  unit: 'm' | 'm2';
  operator: '>=' | '<=';
  threshold: number;
}
export interface EngineeringDatum {
  object: { scope: string; table: string; id: string };
  concept: string;
  unit: 'm' | 'mm' | 'm2' | 'mm2';
  value: number;
  source: string;
  modelVersion: string;
  confirmed: boolean;
}
export interface Diagnostic {
  status: 'ready' | 'missing-data' | 'semantic-mismatch' | 'clarification-required' | 'unsupported';
  reason: string;
}
export function validateRule(value: unknown): asserts value is EngineeringRule {
  const r = value as EngineeringRule;
  if (!r || typeof r.id !== 'string' || !r.id.trim() || typeof r.version !== 'string' || !r.version.trim() ||
      typeof r.reviewed !== 'boolean' || !r.source ||
      [r.source.document, r.source.locator, r.source.text, r.applicability, r.concept].some(x => typeof x !== 'string' || !x.trim()) ||
      !['m', 'm2'].includes(r.unit) || !['>=', '<='].includes(r.operator) || !Number.isFinite(r.threshold))
    throw new Error('Invalid engineering rule contract');
}
export function diagnose(rule: EngineeringRule, datum?: EngineeringDatum): Diagnostic {
  validateRule(rule);
  if (!rule.reviewed) return { status: 'clarification-required', reason: 'Candidate rule requires review' };
  if (!datum) return { status: 'missing-data', reason: `Missing ${rule.concept}` };
  if (datum.concept !== rule.concept) return { status: 'semantic-mismatch', reason: `Required ${rule.concept}, received ${datum.concept}` };
  if (datum.confirmed !== true || !datum.source?.trim() || !datum.modelVersion?.trim())
    return { status: 'clarification-required', reason: 'Data meaning and provenance require confirmation' };
  if (!datum.object?.scope || !datum.object.table || !datum.object.id || !Number.isFinite(datum.value))
    return { status: 'missing-data', reason: 'Finite value and scoped object reference required' };
  const compatible = rule.unit === 'm' ? ['m', 'mm'] : ['m2', 'mm2'];
  if (!compatible.includes(datum.unit)) return { status: 'unsupported', reason: 'Incompatible measurement dimension' };
  return { status: 'ready', reason: 'Reviewed scalar contract satisfied' };
}
export function executeRule(rule: EngineeringRule, datum?: EngineeringDatum) {
  const diagnostic = diagnose(rule, datum);
  const base = { ruleId: rule.id, ruleVersion: rule.version, tool: 'scalar-threshold@1', diagnostic, source: rule.source,
    applicability: rule.applicability };
  if (diagnostic.status !== 'ready') return { ...base, status: 'indeterminate' as const };
  const d = datum!;
  const value = d.value * (d.unit === 'mm' ? 0.001 : d.unit === 'mm2' ? 0.000001 : 1);
  const passed = rule.operator === '>=' ? value >= rule.threshold : value <= rule.threshold;
  return { ...base, status: passed ? 'pass' as const : 'fail' as const,
    evidence: { object: d.object, modelVersion: d.modelVersion, dataSource: d.source, inputValue: d.value,
      inputUnit: d.unit, normalizedValue: value, unit: rule.unit, threshold: rule.threshold, operator: rule.operator } };
}
