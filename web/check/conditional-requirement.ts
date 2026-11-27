import { validateRule, type EngineeringRule } from './core/index.js';

export const WINDOW_SILL_HEIGHT = 'window.sill-clear-height';
export const WINDOW_PROTECTION_TOOL = 'conditional-requirement@1';
export type ConditionalRequirementRule = Pick<EngineeringRule, 'id' | 'version' | 'reviewed' | 'source' | 'applicability'> & {
  kind: 'conditional-requirement';
  profile: 'window-sill-protection';
  sillThreshold: number;
};

export function validateConditionalRequirement(rule: ConditionalRequirementRule) {
  if (rule?.kind !== 'conditional-requirement' || rule.profile !== 'window-sill-protection' ||
      !Number.isFinite(rule.sillThreshold) || rule.sillThreshold <= 0)
    throw new Error('外窗防护规则缺少有效的净高触发限值。');
  validateRule({ ...rule, concept: WINDOW_SILL_HEIGHT, unit: 'm', operator: '>=', threshold: rule.sillThreshold });
}
