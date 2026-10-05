// ---------------------------------------------------------------------------
// Nice-number tick algorithm (Heckbert 1990)
// ---------------------------------------------------------------------------

export function niceNum(range: number, round: boolean): number {
    const exp = Math.floor(Math.log10(range));
    const f   = range / Math.pow(10, exp);
    let nf: number;
    if (round) {
        if      (f < 1.5) nf = 1;
        else if (f < 3.0) nf = 2;
        else if (f < 7.0) nf = 5;
        else              nf = 10;
    } else {
        if      (f <= 1)  nf = 1;
        else if (f <= 2)  nf = 2;
        else if (f <= 5)  nf = 5;
        else              nf = 10;
    }
    return nf * Math.pow(10, exp);
}

export function niceTicks(min: number, max: number, targetCount = 5): number[] {
    const range   = niceNum(max - min, false);
    const step    = niceNum(range / targetCount, true);
    const tickMin = Math.floor(min / step) * step;
    const tickMax = Math.ceil (max / step) * step;
    const ticks: number[] = [];
    for (let v = tickMin; v <= tickMax + step * 1e-6; v += step) {
        ticks.push(Math.round(v / step) * step);
    }
    return ticks;
}

/**
 * Formats a tick value. When `step` is given and the value is so large relative to it that four
 * significant digits would make neighbouring ticks identical, enough decimals are shown instead.
 */
export function formatTick(v: number, step?: number): string {
    if (step !== undefined && step > 0 && Math.abs(v) >= step * 1000 && Math.abs(v) < 1e15) {
        const decimals = Math.min(12, Math.max(0, Math.ceil(-Math.log10(step))));
        return String(parseFloat(v.toFixed(decimals)));
    }
    if (Number.isInteger(v)) return String(v);
    return parseFloat(v.toPrecision(4)).toString();
}

export function getInteriorTicks(min: number, max: number, minCount = 4): number[] {
    for (let target = 5; target <= 24; target++) {
        const t = niceTicks(min, max, target).filter(v => v > min && v < max);
        if (t.length >= minCount) return t;
    }
    return niceTicks(min, max, 5).filter(v => v > min && v < max);
}

/** Returns the tick step that getInteriorTicks would use for the given range. */
export function getTickStep(min: number, max: number): number {
    const ticks = getInteriorTicks(min, max);
    if (ticks.length >= 2) return ticks[1]! - ticks[0]!;
    const range = niceNum(max - min, false);
    return niceNum(range / 5, true);
}

/** Generates interior ticks for [min, max] using a fixed step. */
export function ticksFromStep(min: number, max: number, step: number): number[] {
    const tickMin = Math.floor(min / step) * step;
    const tickMax = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let v = tickMin; v <= tickMax + step * 1e-6; v += step) {
        const rv = Math.round(v / step) * step;
        if (rv > min && rv < max) ticks.push(rv);
    }
    return ticks;
}

/** Integer tick positions for categorical (string) axes. */
export function categoricalTicks(viewMin: number, viewMax: number): number[] {
    const ticks: number[] = [];
    const start = Math.ceil(viewMin + 1e-9);
    const end   = Math.floor(viewMax - 1e-9);
    for (let i = start; i <= end; i++) ticks.push(i);
    return ticks;
}

/** Returns the best tick step in ms for a datetime range width `spanMs`. */
export function getDateTickStep(spanMs: number): number {
    const SEC = 1e3, MIN = 60*SEC, HOUR = 60*MIN, DAY = 24*HOUR;
    const MONTH = 30.44*DAY, YEAR = 365.25*DAY;
    const candidates = [
        SEC, 2*SEC, 5*SEC, 10*SEC, 15*SEC, 30*SEC,
        MIN, 2*MIN, 5*MIN, 10*MIN, 15*MIN, 30*MIN,
        HOUR, 2*HOUR, 3*HOUR, 6*HOUR, 12*HOUR,
        DAY, 2*DAY, 7*DAY, 14*DAY,
        MONTH, 2*MONTH, 3*MONTH, 6*MONTH,
        YEAR, 2*YEAR, 5*YEAR, 10*YEAR, 20*YEAR, 50*YEAR,
    ];
    for (const step of candidates) {
        const count = spanMs / step;
        if (count >= 3 && count <= 10) return step;
    }
    return DAY;
}

/** Datetime ticks inside [minMs, maxMs] for a fixed step, stable across panning. */
export function dateTicksFromStep(minMs: number, maxMs: number, step: number): number[] {
    const ticks: number[] = [];
    const start = Math.ceil(minMs / step) * step;
    for (let v = start; v <= maxMs - step * 1e-9; v += step) {
        if (v > minMs) ticks.push(v);
    }
    return ticks;
}

export const _PAD2 = (n: number) => n.toString().padStart(2, '0');
export const _MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Formats a timestamp (ms) for display. Precision is derived from the tick step so
 * that adjacent ticks always have distinct labels (e.g. step=14d → "3/15", not "Feb 2026"). */
export function formatDateTick(ms: number, step: number): string {
    const d = new Date(ms);
    const SEC = 1e3, MIN = 60*SEC, HOUR = 60*MIN, DAY = 24*HOUR;
    const MONTH = 30.44*DAY, YEAR = 365.25*DAY;
    if (step < MIN)     return `${_PAD2(d.getHours())}:${_PAD2(d.getMinutes())}:${_PAD2(d.getSeconds())}`;
    if (step < HOUR)    return `${_PAD2(d.getHours())}:${_PAD2(d.getMinutes())}`;
    if (step < DAY)     return `${d.getMonth()+1}/${d.getDate()} ${_PAD2(d.getHours())}h`;
    if (step < MONTH)   return `${d.getMonth()+1}/${d.getDate()}`;
    if (step < YEAR)    return `${_MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
    return String(d.getFullYear());
}
