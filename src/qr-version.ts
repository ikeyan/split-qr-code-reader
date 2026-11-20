/** QR Model 2 version information (ISO BCH(18,6), versions 7 through 40). */
export function qrVersionBits(version: number): number[] {
  let remainder = version << 12;
  for (let bit = 17; bit >= 12; bit--) {
    if (remainder & (1 << bit)) remainder ^= 0x1f25 << (bit - 12);
  }
  const word = (version << 12) | remainder;
  return Array.from({ length: 18 }, (_, i) => (word >> i) & 1);
}

/** Brightness samples, in [0,1]. This is a geometry hint, never a payload read. */
export function readQrVersion(copies: readonly number[][]): number | undefined {
  const decoded: number[] = [];
  for (const copy of copies) {
    if (copy.length !== 18 || copy.some((v) => !Number.isFinite(v))) continue;
    const matches = [];
    for (let version = 7; version <= 40; version++) {
      const bits = qrVersionBits(version);
      const errors = bits.filter((bit, i) =>
        bit !== (copy[i] < .5 ? 1 : 0)
      ).length;
      if (errors <= 3) matches.push(version);
    }
    if (matches.length === 1) decoded.push(matches[0]);
  }
  return decoded.length && decoded.every((v) => v === decoded[0])
    ? decoded[0]
    : undefined;
}
