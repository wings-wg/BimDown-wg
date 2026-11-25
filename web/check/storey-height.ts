export interface ModelLevel {
  id: string;
  name: string;
  elevation?: number;
  usage?: string;
  elevationBasis?: string;
  elevationSource?: string;
  upperLevelId?: string;
}

export type StoreyChoice =
  | { mode: 'upper'; id: string }
  | { mode: 'manual'; height: string; source: string }
  | { mode: 'pending' | 'excluded' };

export function isRoofDatum(level: ModelLevel) {
  return level.usage === 'roof-datum' || !level.usage && /^(?:屋顶|屋面|机房顶|roof)$/i.test(level.name.trim());
}

export function suggestStoreyChoices(levels: ModelLevel[]): Map<string, StoreyChoice> {
  const byElevation = new Map<number, string[]>();
  const byId = new Map(levels.map(level => [level.id, level]));
  for (const { elevation, id } of levels) {
    if (elevation === undefined || !Number.isFinite(elevation)) continue;
    const ids = byElevation.get(elevation) ?? [];
    ids.push(id);
    byElevation.set(elevation, ids);
  }
  const elevations = [...byElevation.keys()].sort((a, b) => a - b);
  const suggestions = new Map<string, StoreyChoice>();
  for (let i = 0; i + 1 < elevations.length; i++) {
    const lower = byElevation.get(elevations[i])!;
    const upper = byElevation.get(elevations[i + 1])!;
    if (lower.length !== 1) continue;
    const level = byId.get(lower[0])!;
    if (isRoofDatum(level)) continue;
    const upperId = level.upperLevelId ?? (upper.length === 1 ? upper[0] : undefined);
    const counterpart = upperId && byId.get(upperId);
    if (counterpart && isStoreyPair(level, counterpart)) suggestions.set(level.id, { mode: 'upper', id: counterpart.id });
  }
  return suggestions;
}

export function isStoreyPair(lower: ModelLevel, upper: ModelLevel) {
  const compatible = (level: ModelLevel) => !level.elevationBasis || level.elevationBasis === 'architectural-finish';
  return lower.elevation !== undefined && upper.elevation !== undefined && lower.elevation < upper.elevation &&
    compatible(lower) && compatible(upper);
}

export function storeyHeightMetres(lower?: number, upper?: number, scale?: number) {
  if (lower === undefined || upper === undefined || scale === undefined ||
      !Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(scale) || upper <= lower) return undefined;
  // Subtract the decimal elevations before converting to Number. For example,
  // binary subtraction of 4.1 and 1.1 otherwise falls just below 3 metres.
  const from = decimalParts(lower);
  const to = decimalParts(upper);
  const unit = decimalParts(scale);
  const exponent = Math.min(from.exponent, to.exponent);
  const interval = to.coefficient * 10n ** BigInt(to.exponent - exponent) -
    from.coefficient * 10n ** BigInt(from.exponent - exponent);
  const metres = Number(`${interval * unit.coefficient}e${exponent + unit.exponent}`);
  return Number.isFinite(metres) && metres > 0 ? metres : undefined;
}

export function manualHeightMetres(value: string) {
  const height = Number(value);
  return Number.isFinite(height) && height > 0 ? height : undefined;
}
import { decimalParts } from './core/decimal.js';

