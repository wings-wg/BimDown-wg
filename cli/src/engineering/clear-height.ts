import { compareDecimalProducts } from './decimal.js';
import { validateRule, type EngineeringRule } from './index.js';

export interface ClearHeightRule extends Pick<EngineeringRule, 'id' | 'version' | 'reviewed' | 'source' | 'applicability'> {
  kind: 'clear-height-with-local-exception';
  nominalHeight: number;
  minimumHeight: number;
  maxLowAreaFraction: { numerator: number; denominator: number };
}

export interface ClearHeightEvidence {
  minimumHeight?: number;
  usableArea?: number;
  lowArea?: number;
  belowHeight: number;
  source: string;
}

export function validateClearHeightRule(rule: ClearHeightRule) {
  validateRule({ ...rule, concept: 'space.finished-clear-height', unit: 'm', operator: '>=', threshold: rule?.nominalHeight });
  const fraction = rule.maxLowAreaFraction;
  if (rule.kind !== 'clear-height-with-local-exception' || !Number.isFinite(rule.minimumHeight) ||
      !(rule.minimumHeight > 0 && rule.minimumHeight < rule.nominalHeight) || !fraction ||
      !Number.isSafeInteger(fraction.numerator) || !Number.isSafeInteger(fraction.denominator) ||
      !(fraction.numerator > 0 && fraction.numerator < fraction.denominator)) {
    throw new Error('净高规则需要有效的常规限值、局部下限和面积比例。');
  }
}

/** Areas use the same finished usable-floor boundary. The low area is strictly below the nominal height. */
export function checkClearHeight(rule: ClearHeightRule, data: ClearHeightEvidence) {
  validateClearHeightRule(rule);
  const indeterminate = (reason: string) => ({ status: 'indeterminate' as const, reason });
  if (!rule.reviewed) return indeterminate('净高规则待审核。');
  const { minimumHeight, usableArea, lowArea } = data;
  if (!data.source.trim() || data.belowHeight !== rule.nominalHeight ||
      minimumHeight === undefined || usableArea === undefined || lowArea === undefined)
    return indeterminate('请填写最低净高、房间使用面积、对应限值的低净高面积和证据来源。');
  if (![minimumHeight, usableArea, lowArea].every(Number.isFinite) ||
      minimumHeight <= 0 || usableArea <= 0 || lowArea < 0 || lowArea > usableArea)
    return indeterminate('净高和使用面积须大于 0，低净高面积须介于 0 和使用面积之间。');
  if (minimumHeight >= rule.nominalHeight && lowArea > 0)
    return indeterminate('最低净高达到常规限值，但录入了低净高面积，请核对证据。');

  const { numerator, denominator } = rule.maxLowAreaFraction;
  const belowMinimum = minimumHeight < rule.minimumHeight;
  const exceedsArea = compareDecimalProducts(lowArea, denominator, usableArea, numerator) > 0n;
  const failures = [belowMinimum ? '最低净高低于局部下限' : '', exceedsArea ? '低净高面积占比超过限值' : ''].filter(Boolean);
  return {
    status: failures.length ? 'fail' as const : 'pass' as const,
    reason: failures.join('；'),
    evidence: { minimumHeight, usableArea, lowArea, belowHeight: data.belowHeight, ratio: lowArea / usableArea, source: data.source },
  };
}
