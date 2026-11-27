export function decimalParts(value: number) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [integer, fraction = ''] = mantissa.split('.');
  return { coefficient: BigInt(integer + fraction), exponent: Number(exponent) - fraction.length };
}

// Sum finite decimal inputs before applying report rounding.
export function decimalSum(values: number[]) {
  const parts = values.map(decimalParts);
  const exponent = parts.reduce((min, part) => Math.min(min, part.exponent), 0);
  const coefficient = parts.reduce((sum, part) => sum + part.coefficient * 10n ** BigInt(part.exponent - exponent), 0n);
  return { coefficient, exponent, raw: Number(`${coefficient}e${exponent}`) };
}

export function halfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) return -halfUp(-numerator, denominator);
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function cents(values: number[]) {
  const { coefficient, exponent } = decimalSum(values);
  return exponent >= -2 ? coefficient * 10n ** BigInt(exponent + 2)
    : halfUp(coefficient, 10n ** BigInt(-2 - exponent));
}

export const squareMetres = (value: bigint) => Number(value) / 100;

export function compareDecimalProducts(left: number, leftFactor: number, right: number, rightFactor: number) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const exponent = Math.min(a.exponent, b.exponent);
  return a.coefficient * BigInt(leftFactor) * 10n ** BigInt(a.exponent - exponent) -
    b.coefficient * BigInt(rightFactor) * 10n ** BigInt(b.exponent - exponent);
}
