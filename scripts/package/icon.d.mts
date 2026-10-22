// Types for icon.mjs (stage.mjs and the unit tests import it).
export declare const ICO_SIZES: number[];
export declare const ICONSET: { name: string; size: number }[];
export declare function icoFromPngs(images: { size: number; png: Buffer }[]): Buffer;
export declare function writeIco(svg: string, out: string): Promise<void>;
export declare function writeIconset(svg: string, dir: string): Promise<void>;
