/// <reference types="opentype.js" />
import * as opentype from "opentype.js";
import defaultFontData from "../fonts/helvetica/roboto-13281/RobotoRegular-3m4L.ttf";

export interface FontSource {
    /** URL of a TTF/OTF font. */
    url?: string | undefined;
    /** Raw TTF/OTF bytes. Takes precedence over `url`. */
    data?: ArrayBuffer | Uint8Array | undefined;
}

const cache = new Map<string, Promise<opentype.Font>>();
const dataCache = new WeakMap<object, Promise<opentype.Font>>();

function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
    if (data instanceof ArrayBuffer) return data;
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** Loads (and caches) a font. With no source, the bundled Roboto Regular is used. */
export function loadFont(src: FontSource = {}): Promise<opentype.Font> {
    if (src.data) {
        let p = dataCache.get(src.data);
        if (!p) {
            p = Promise.resolve().then(() => opentype.parse(toArrayBuffer(src.data!)));
            dataCache.set(src.data, p);
        }
        return p;
    }
    const key = src.url ?? '<default>';
    let p = cache.get(key);
    if (!p) {
        p = src.url
            ? opentype.load(src.url)
            : Promise.resolve().then(() => opentype.parse(toArrayBuffer(defaultFontData)));
        p.catch(() => cache.delete(key));
        cache.set(key, p);
    }
    return p;
}
