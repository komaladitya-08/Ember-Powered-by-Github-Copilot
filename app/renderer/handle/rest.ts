/** When the handle's face may stop drawing: pure, so it is tested without a window. */

/** Dozing with nothing passing, and not talking or streaming: the last frame can stay. */
export function mayRest(asleep: boolean, settled: boolean, busy: boolean): boolean {
  return asleep && settled && !busy;
}
