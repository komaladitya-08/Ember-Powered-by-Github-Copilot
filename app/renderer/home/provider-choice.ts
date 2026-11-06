/**
 * A count of the user's deliberate changes to their own model provider made in Home (the switch, the address, the
 * models, the key, the card's yes), shared with first run (PR #191 re-review). First run's check puts the provider away
 * again when it is abandoned, but only if nobody has chosen anything since it began: a later deliberate choice owns
 * the provider, and a late compensation must not undo it. Nothing here is saved or sent.
 */
let choices = 0;
const listeners = new Set<() => void>();

/** How many deliberate provider choices have been made on this page. */
export const providerChoice = (): number => choices;

/** Records a deliberate choice; whoever showed a failure about the provider's old state is told to drop it. */
export function noteProviderChoice(): void {
  choices++;
  for (const fn of [...listeners]) fn();
}

/** Calls `fn` at every deliberate choice. */
export function onProviderChoice(fn: () => void): void { listeners.add(fn); }
