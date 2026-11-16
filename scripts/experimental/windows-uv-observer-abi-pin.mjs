/** Immutable fixed ordinary-host control policy; no caller-selected source, cases or executable authority. */
import fs from "node:fs";
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const abiPin = freeze(JSON.parse(fs.readFileSync(new URL("./windows-uv-observer-abi-pin.json", import.meta.url), "utf8")));
