/**
 * What the desk view says to assistive technology. Taken over, every key (Tab and Escape too) goes to the desk, and
 * only Ctrl+Alt+End comes back (WCAG 2.1.2 allows that when the user is told): the picture's name and a live
 * announcement say so. Pure, so it is unit-tested.
 */

/** The keys that hand the desk back (main.ts lets them through to nothing else). */
export const HAND_BACK_KEYS = "Ctrl+Alt+End";

/** The desk picture's name: what it shows, or, taken over, where the keys go and the way back. */
export function screenName(control: boolean): string {
  return control ? `Ember's desk. Your keys go to the desk. Press ${HAND_BACK_KEYS} to hand back.` : "What Ember is doing on its desk";
}

/** What is announced when the keyboard moves to the desk (`control`) or back (`was`: before); null when nothing moved. */
export function modeNews(control: boolean, was: boolean): string | null {
  if (control === was) return null;
  return control ? `You have the keyboard on the desk. Press ${HAND_BACK_KEYS} to hand back.` : "You handed the desk back to Ember.";
}
