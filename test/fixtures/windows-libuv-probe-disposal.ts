/** Uncertainty revokes release; a non-disposing stop of a known LPAC root/job is still attempted. */
export async function disposeWindowsLibuvProbe(input: {
  unsafe: boolean;
  lpacCreated: boolean;
  stopLpac(): Promise<void>;
  closeFixture(): Promise<void>;
  releasePins(): void;
}): Promise<boolean> {
  if (input.unsafe) {
    if (input.lpacCreated) try { await input.stopLpac(); } catch { /* Retain every owner even after the stop attempt. */ }
    return true;
  }
  try { await input.closeFixture(); } catch { return true; }
  try { input.releasePins(); } catch { return true; }
  return false;
}
