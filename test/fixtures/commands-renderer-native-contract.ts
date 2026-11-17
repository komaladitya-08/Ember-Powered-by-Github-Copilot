/** Closed numeric observations from the synthetic Commands renderer; these confer no production or input authority. */
import { types } from "node:util";

export const COMMANDS_RENDERER_SAMPLE_PREFIX = "EMBER_COMMANDS_RENDERER_SAMPLE_V1:";
export const COMMANDS_RENDERER_READY_PREFIX = "EMBER_COMMANDS_RENDERER_READY_V1:";
/** Private loadCode0..7 / first-quit-caller0..4 observation, always before a refused READY0. */
export const COMMANDS_RENDERER_LOAD_PREFIX = "EMBER_COMMANDS_RENDERER_LOAD_V1:";
/** Every bit comes from a fixed synthetic control, real renderer report or independent DOM geometry sample. */
export const COMMANDS_RENDERER_MASKS = Object.freeze({
  dom: Object.freeze({ commandPresent: 1, allowPresent: 2, allowEnabled: 4, denyEnabled: 8, allowDisabled: 16 }),
  geometry: Object.freeze({ fits: 1, atEnd: 2, onScreen: 4, visible: 8, inClip: 16, inViewport: 32, positiveArea: 64, stickyClear: 128 }),
  reported: Object.freeze({ present: 1, seen: 2, inView: 4 }),
  assets: Object.freeze({ sourceVerified: 1, sandboxed: 2, fontsReady: 4 }),
  lifecycle: Object.freeze({ firstDelivered: 1, firstAnswered: 2, liveAttached: 4, outputFlushed: 8, ended: 16, pendingCleared: 32, secondDelivered: 64, monotonic: 128 }),
});
/** arm: 0 unknown; 1 definitely before the arm deadline; 2 definitely past it, bounded by an actual cardSeen timestamp. */
export interface CommandsRendererSample {
  schema: 1; sequence: number; card: number; dom: number; geometry: number; reported: number; arm: number; assets: number; lifecycle: number;
}
/** Reject getters, proxies, symbols, extra keys, non-integers and inconsistent control/report flags without invoking them. */
export function parseCommandsRendererSample(value: unknown): CommandsRendererSample | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return null;
  const ranges = { schema: [1, 1], sequence: [1, 16], card: [0, 2], dom: [0, 31], geometry: [0, 255], reported: [0, 7], arm: [0, 2], assets: [0, 7], lifecycle: [0, 255] };
  const keys = Reflect.ownKeys(value);
  if (keys.length !== Object.keys(ranges).length || keys.some(key => typeof key !== "string" || !Object.hasOwn(ranges, key))) return null;
  const result: Record<string, number> = {};
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const property = Object.getOwnPropertyDescriptor(value, key), field: unknown = property && Object.hasOwn(property, "value") ? property.value : undefined;
    if (typeof field !== "number" || !Number.isInteger(field) || field < min || field > max) return null;
    result[key] = field;
  }
  if ((result.dom & 4) && (!(result.dom & 2) || (result.dom & 16))) return null;
  if ((result.dom & 16) && !(result.dom & 2)) return null;
  if ((result.reported & 6) && !(result.reported & 1)) return null;
  if ((result.reported & 4) && !(result.reported & 2)) return null;
  return result as unknown as CommandsRendererSample;
}
