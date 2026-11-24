export function decimalParts(value: number) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [integer, fraction = ''] = mantissa.split('.');
  return { coefficient: BigInt(integer + fraction), exponent: Number(exponent) - fraction.length };
}

export function compareDecimalProducts(left: number, leftFactor: number, right: number, rightFactor: number) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const exponent = Math.min(a.exponent, b.exponent);
  return a.coefficient * BigInt(leftFactor) * 10n ** BigInt(a.exponent - exponent) -
    b.coefficient * BigInt(rightFactor) * 10n ** BigInt(b.exponent - exponent);
}
