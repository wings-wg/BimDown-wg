import { validateRule, type EngineeringRule } from './core/index.js';

export const stairHeadroomBranches = {
  flight: { label: '梯段', concept: 'stair.flight-minimum-headroom' },
  landing: { label: '平台', concept: 'stair.landing-minimum-headroom' },
} as const;
export type StairHeadroomBranch = keyof typeof stairHeadroomBranches;
export const stairHeadroomTables = { stair: 'flight', stair_run: 'flight', stair_landing: 'landing' } as const;

export type ComponentMinimumRule = Pick<EngineeringRule, 'id' | 'version' | 'reviewed' | 'source' | 'applicability'> & {
  kind: 'component-minimum';
  profile: 'stair-headroom';
  thresholds: Record<StairHeadroomBranch, number>;
};

export function validateComponentMinimum(rule: ComponentMinimumRule) {
  if (rule?.kind !== 'component-minimum' || rule.profile !== 'stair-headroom' || !rule.thresholds ||
      Object.keys(rule.thresholds).length !== Object.keys(stairHeadroomBranches).length)
    throw new Error('分档规则缺少已注册的楼梯净空量测口径。');
  for (const [branch, config] of Object.entries(stairHeadroomBranches)) {
    const threshold = rule.thresholds[branch as StairHeadroomBranch];
    if (!Object.hasOwn(rule.thresholds, branch) || !Number.isFinite(threshold) || threshold <= 0)
      throw new Error(`缺少有效的${config.label}净高下限。`);
    validateRule({ ...rule, concept: config.concept, unit: 'm', operator: '>=', threshold });
  }
}
