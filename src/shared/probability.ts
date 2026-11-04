/** Draw once per context build. Endpoints avoid consuming randomness. */
export function chance(
  probability: number,
  random: () => number = Math.random,
): boolean {
  return probability >= 1 || (probability > 0 && random() < probability);
}
