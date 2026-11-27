import type { EngineeringRule } from './core/index.js';
import { validDwellingMinimum, type MinimumDwellingCount } from './core/dwelling-count.js';

export type DwellingMinimumRule = Pick<EngineeringRule, 'id' | 'version' | 'reviewed' | 'source' | 'applicability'> &
  MinimumDwellingCount & { kind: 'dwelling-count-minimum'; profile: 'accessible-dwellings' };

export function validateDwellingMinimumRule(rule: DwellingMinimumRule) {
  if (rule?.kind !== 'dwelling-count-minimum' || rule.profile !== 'accessible-dwellings' ||
      typeof rule.reviewed !== 'boolean' || ![rule.id, rule.version, rule.applicability, rule.source?.document,
        rule.source?.locator, rule.source?.text].every(value => typeof value === 'string' && !!value.trim()) ||
      !validDwellingMinimum(rule)) throw new Error('逐户计数规则缺少有效的审核范围、依据或限值。');
}
