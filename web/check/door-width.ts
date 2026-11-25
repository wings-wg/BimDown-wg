import { validateRule, type EngineeringRule } from './core/index.js';

export const DOOR_WIDTH = 'door.effective-clear-width';
export const doorUses = { entrance: '户门', habitable: '居室门', kitchen: '厨房门', bathroom: '卫生间门' } as const;
export type DoorUse = keyof typeof doorUses;
export type DoorThresholds = Record<DoorUse, number>;
export type DoorWidthRule = Pick<EngineeringRule, 'id' | 'version' | 'reviewed' | 'source' | 'applicability'> & {
  kind: 'door-clear-width-by-use';
  thresholds: DoorThresholds;
  registeredToolId: string;
};

export function validateDoorWidthRule(rule: DoorWidthRule) {
  if (rule?.kind !== 'door-clear-width-by-use' || !rule.thresholds ||
      Object.keys(rule.thresholds).length !== Object.keys(doorUses).length ||
      rule.registeredToolId !== `pal.${DOOR_WIDTH}.read@1`)
    throw new Error('门净宽规则需要四类门的限值和已注册的有效通行净宽工具。');
  for (const key of Object.keys(doorUses) as DoorUse[]) {
    if (!(rule.thresholds[key] > 0)) throw new Error('门净宽限值须为正数。');
    validateRule({ ...rule, concept: DOOR_WIDTH, unit: 'm', operator: '>=', threshold: rule.thresholds[key] });
  }
}
