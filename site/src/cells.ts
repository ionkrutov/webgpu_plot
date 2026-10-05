const MARKER = /^\s*(?:\/\/|%)\s*%%\s*(.*)$/;

export interface Cell { title: string; line: number }

/** Cells start at lines like `// %% Title` (0-based line numbers). */
export function findCells(code: string): Cell[] {
    const cells: Cell[] = [];
    code.split('\n').forEach((text, line) => {
        const m = MARKER.exec(text);
        if (m) cells.push({ title: m[1]!.trim(), line });
    });
    return cells;
}

/** Exclusive end line of the cell that contains `line`: the next marker or the end of the code. */
export function cellEnd(code: string, line: number): number {
    const lines = code.split('\n');
    for (let i = line + 1; i < lines.length; i++) if (MARKER.test(lines[i]!)) return i;
    return lines.length;
}

const IMPORT = /^[ \t]*import\s+(type\s+)?([^;'"]*?)\s*from\s*["']webgpu-plot["'][ \t]*;?/gm;

export interface Prepared {
    code: string;
    /** True when the code imports from "webgpu-plot" itself, so the runner must not inject globals. */
    usesImport: boolean;
}

/**
 * Turns the editor text into a function body: cell markers become __cell() calls and imports of
 * "webgpu-plot" become destructuring of the WebGPUPlot global. Line numbers are preserved.
 * `endLine` (exclusive) runs only the first lines, i.e. everything up to the end of a cell.
 */
export function prepare(source: string, endLine?: number): Prepared {
    let lines = source.split('\n');
    if (endLine !== undefined) lines = lines.slice(0, endLine);

    let cellIndex = 0;
    const withCells = lines.map(text => {
        const m = MARKER.exec(text);
        return m ? `__cell(${cellIndex++}, ${JSON.stringify(m[1]!.trim())});` : text;
    }).join('\n');

    let usesImport = false;
    const code = withCells.replace(IMPORT, (match, type: string | undefined, clause: string) => {
        usesImport = true;
        const breaks = '\n'.repeat(match.split('\n').length - 1);
        if (type) return breaks;
        const c = clause.trim();
        if (c.startsWith('*')) {
            const name = /^\*\s+as\s+([\w$]+)$/.exec(c)?.[1];
            if (!name) throw new Error(`Unsupported import: ${match.trim()}`);
            return `const ${name} = WebGPUPlot;${breaks}`;
        }
        if (c.startsWith('{')) return `const ${c.replace(/\bas\b/g, ':')} = WebGPUPlot;${breaks}`;
        throw new Error('Only named imports from "webgpu-plot" are supported: import { plot } from "webgpu-plot"');
    });
    return { code, usesImport };
}
