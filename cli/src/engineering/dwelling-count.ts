export type MinimumDwellingCount = {
  minimumCount: number;
  minimumFraction: { numerator: number; denominator: number };
};

export function validDwellingMinimum(value: MinimumDwellingCount | undefined): value is MinimumDwellingCount {
  const ratio = value?.minimumFraction;
  return !!value && Number.isSafeInteger(value.minimumCount) && value.minimumCount >= 0 &&
    !!ratio && Number.isSafeInteger(ratio.numerator) && Number.isSafeInteger(ratio.denominator) &&
    ratio.denominator > 0 && ratio.numerator > 0 && ratio.numerator <= ratio.denominator;
}

export function sameDwellingMinimum(left: MinimumDwellingCount, right: MinimumDwellingCount) {
  return left.minimumCount === right.minimumCount &&
    BigInt(left.minimumFraction.numerator) * BigInt(right.minimumFraction.denominator) ===
    BigInt(right.minimumFraction.numerator) * BigInt(left.minimumFraction.denominator);
}

export function evaluateDwellingMinimum(total: number, accessible: number, minimum: MinimumDwellingCount) {
  if (!validDwellingMinimum(minimum) || !Number.isSafeInteger(total) || total <= 0 ||
      !Number.isSafeInteger(accessible) || accessible < 0 || accessible > total)
    throw new Error('Invalid dwelling count or minimum');
  const { numerator, denominator } = minimum.minimumFraction;
  const divisor = BigInt(denominator);
  const proportionalMinimum = Number((BigInt(total) * BigInt(numerator) + divisor - 1n) / divisor);
  const required = Math.max(minimum.minimumCount, proportionalMinimum);
  return { total, accessible, proportionalMinimum, required, shortfall: Math.max(0, required - accessible) };
}
