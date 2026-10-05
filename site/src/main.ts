import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/editor.all';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import { cellEnd, findCells, prepare } from './cells';
import { Runner } from './runner';
import type { RunMessage } from './runner';

interface Example { id: string; title: string; code: string }

const STORAGE_KEY = 'webgpu-plot-site:code';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorkerUrl: (_id, label) => label === 'typescript' || label === 'javascript' ? 'ts.worker.js' : 'editor.worker.js',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- code <-> URL hash (deflate + base64url, no server needed) ----

async function pack(text: string): Promise<string> {
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function unpack(data: string): Promise<string> {
    const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

async function main(): Promise<void> {
    const [types, examples] = await Promise.all([
        fetch('types.json').then(r => r.json() as Promise<Record<string, string>>),
        fetch('examples.json').then(r => r.json() as Promise<Example[]>),
    ]);

    // ---- editor with completions for the library ----
    const js = monaco.languages.typescript.javascriptDefaults;
    const ts = monaco.languages.typescript;
    js.setCompilerOptions({
        target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs,
        allowNonTsExtensions: true, allowJs: true, checkJs: true, noEmit: true, lib: ['es2022', 'dom'],
    });
    js.setEagerModelSync(true);
    for (const [name, text] of Object.entries(types)) js.addExtraLib(text, `file:///node_modules/webgpu-plot/${name}`);
    js.addExtraLib('{"name":"webgpu-plot","types":"./index.d.ts"}', 'file:///node_modules/webgpu-plot/package.json');

    const hash = new URLSearchParams(location.hash.slice(1));
    let initial = examples[0]?.code ?? '';
    const exampleId = hash.get('example');
    if (hash.has('code')) {
        try { initial = await unpack(hash.get('code')!); } catch { /* fall back to the default example */ }
    } else if (exampleId && examples.some(e => e.id === exampleId)) {
        initial = examples.find(e => e.id === exampleId)!.code;
    } else {
        initial = localStorage.getItem(STORAGE_KEY) ?? initial;
    }

    const model = monaco.editor.createModel(initial, 'javascript', monaco.Uri.parse('file:///main.js'));
    const editor = monaco.editor.create($('editor'), {
        model, theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 14,
        scrollBeyondLastLine: false, tabSize: 4, codeLens: true, renderLineHighlight: 'line',
    });

    // ---- run ----
    const status = $('status');
    const consoleBody = $('console-body');
    const runner = new Runner($('frame-host'), onMessage);

    function print(level: string, text: string): void {
        const line = document.createElement('div');
        line.className = `log-${level}`;
        line.textContent = text;
        consoleBody.appendChild(line);
        consoleBody.scrollTop = consoleBody.scrollHeight;
    }

    function onMessage(m: RunMessage): void {
        if (m.type === 'log') print(m.level, m.text);
        else if (m.type === 'done') status.textContent = `Done in ${m.ms} ms`;
        else {
            status.textContent = 'Error';
            print('error', m.line ? `Line ${m.line}: ${m.message}` : m.message);
            if (m.line) {
                const lineNo = Math.min(Math.max(m.line, 1), model.getLineCount());
                monaco.editor.setModelMarkers(model, 'run', [{
                    severity: monaco.MarkerSeverity.Error, message: m.message,
                    startLineNumber: lineNo, startColumn: 1, endLineNumber: lineNo, endColumn: model.getLineMaxColumn(lineNo),
                }]);
            }
        }
    }

    function run(endLine?: number): void {
        monaco.editor.setModelMarkers(model, 'run', []);
        consoleBody.textContent = '';
        status.textContent = 'Running…';
        try {
            const p = prepare(model.getValue(), endLine);
            runner.run(p.code, !p.usesImport);
        } catch (e) {
            status.textContent = 'Error';
            print('error', e instanceof Error ? e.message : String(e));
        }
    }

    const runAll = () => run();
    const runToCursorCell = () => {
        const line = editor.getPosition()?.lineNumber ?? 1;
        const cells = findCells(model.getValue());
        const start = [...cells].reverse().find(c => c.line <= line - 1)?.line ?? 0;
        run(cellEnd(model.getValue(), start));
    };

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runAll);
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, runToCursorCell);
    $('run-all').addEventListener('click', runAll);
    $('run-cell').addEventListener('click', runToCursorCell);
    $('clear').addEventListener('click', () => { consoleBody.textContent = ''; });

    // "Run up to here" above every `// %%` marker
    const lensCommand = editor.addCommand(0, (_ctx, line: number) => run(cellEnd(model.getValue(), line)));
    monaco.languages.registerCodeLensProvider('javascript', {
        provideCodeLenses: m => ({
            lenses: m === model && lensCommand ? findCells(m.getValue()).map(c => ({
                range: { startLineNumber: c.line + 1, startColumn: 1, endLineNumber: c.line + 1, endColumn: 1 },
                command: { id: lensCommand, title: '▶ Run up to here', arguments: [c.line] },
            })) : [],
            dispose() { /* nothing to release */ },
        }),
    });

    // highlight cell marker lines
    const decorations = editor.createDecorationsCollection();
    const markCells = () => {
        decorations.set(findCells(model.getValue()).map(c => ({
            range: new monaco.Range(c.line + 1, 1, c.line + 1, 1),
            options: { isWholeLine: true, className: 'cell-marker' },
        })));
    };
    markCells();

    // ---- examples, persistence, sharing ----
    const select = $<HTMLSelectElement>('examples');
    select.add(new Option('Examples…', ''));
    for (const e of examples) select.add(new Option(e.title, e.id));
    select.addEventListener('change', () => {
        const e = examples.find(x => x.id === select.value);
        if (e) { model.setValue(e.code); history.replaceState(null, '', `#example=${e.id}`); runAll(); }
        select.value = '';
    });

    let saveTimer = 0;
    model.onDidChangeContent(() => {
        markCells();
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => localStorage.setItem(STORAGE_KEY, model.getValue()), 400);
    });

    $('share').addEventListener('click', async () => {
        const url = `${location.origin}${location.pathname}#code=${await pack(model.getValue())}`;
        history.replaceState(null, '', url);
        try { await navigator.clipboard.writeText(url); status.textContent = 'Link copied'; }
        catch { status.textContent = 'Link is in the address bar'; }
    });

    // ---- layout: draggable divider ----
    const layout = $('layout');
    $('divider').addEventListener('pointerdown', e => {
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
            const r = layout.getBoundingClientRect();
            const pct = Math.min(80, Math.max(20, (ev.clientX - r.left) / r.width * 100));
            layout.style.setProperty('--split', `${pct}%`);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
    });

    if (!navigator.gpu) {
        const banner = $('banner');
        banner.hidden = false;
        banner.textContent = 'WebGPU is not available in this browser. Use a recent Chrome or Edge over HTTPS (or localhost).';
    }

    runAll();
}

void main();
