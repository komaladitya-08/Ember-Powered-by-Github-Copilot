/**
 * XTest takes physical button numbers and the X server maps them through the core pointer map, which a left-handed
 * user may have swapped (xmodmap -e "pointer = 3 2 1"): Ember sends the physical button the map turns into the
 * logical one it means, as the Windows backend does for swapped buttons.
 */

import { describe, expect, it } from "vitest";
import { physicalButton } from "../../app/main/hands/input";

describe("the physical button for a logical one", () => {
  const identity = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("is the same button with the default map", () => {
    for (const b of [1, 2, 3, 4, 5, 6, 7]) expect(physicalButton(identity, b)).toBe(b);
  });

  it("inverts a left-handed map, so a left click stays a left click (review #64)", () => {
    const leftHanded = [3, 2, 1, 4, 5, 6, 7, 8, 9, 10];
    expect(physicalButton(leftHanded, 1)).toBe(3);
    expect(physicalButton(leftHanded, 3)).toBe(1);
    expect(physicalButton(leftHanded, 2)).toBe(2);
  });

  it("inverts the wheel too, so scrolling down scrolls the content down under a reversed wheel", () => {
    const reversed = [3, 2, 1, 5, 4, 7, 6, 8, 9, 10];
    expect(physicalButton(reversed, 5)).toBe(4);
    expect(physicalButton(reversed, 4)).toBe(5);
    expect(physicalButton(reversed, 6)).toBe(7);
  });

  it("takes the first physical button when several give it, and the button itself when none does or the map is unknown", () => {
    expect(physicalButton([1, 1, 3], 1)).toBe(1);
    expect(physicalButton([0, 2, 1], 1)).toBe(3); // button 1 switched off, button 3 is the left click now
    expect(physicalButton([0, 2, 3], 1)).toBe(1); // nothing gives a left click: today's number
    expect(physicalButton([1, 2, 3], 5)).toBe(5); // a map shorter than the button
    expect(physicalButton([], 1)).toBe(1);
  });
});
