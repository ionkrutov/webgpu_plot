export type RunMessage =
    | { type: 'log'; level: 'log' | 'info' | 'warn' | 'error'; text: string }
    | { type: 'error'; message: string; line: number | null }
    | { type: 'done'; ms: number };

const CSS = `
html, body { margin: 0; background: #fff; font: 14px system-ui, sans-serif; color: #222; }
body { padding: 8px 12px 24px; }
.cell-title { margin: 18px 0 8px; font-size: 13px; font-weight: 600; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
body .wgp-window { width: 100%; height: 520px; margin-bottom: 12px; }
`;

/**
 * Runs user code in a sandboxed iframe: no access to this page, and a runaway script or a lost
 * GPU device only affects the frame. Each run gets a fresh frame, so every figure starts clean.
 */
export class Runner {
    private frame: HTMLIFrameElement | null = null;

    constructor(private readonly host: HTMLElement, private readonly onMessage: (m: RunMessage) => void) {
        window.addEventListener('message', e => {
            const d = e.data as { __wgp?: number; msg?: RunMessage } | null;
            if (this.frame && e.source === this.frame.contentWindow && d?.__wgp === 1 && d.msg) this.onMessage(d.msg);
        });
    }

    run(code: string, injectGlobals: boolean): void {
        this.stop();
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-downloads');
        frame.srcdoc = this.document(code, injectGlobals);
        this.host.appendChild(frame);
        this.frame = frame;
    }

    stop(): void {
        this.frame?.remove();
        this.frame = null;
    }

    private document(code: string, injectGlobals: boolean): string {
        const lib = new URL('webgpu-plot.iife.js', document.baseURI).href;
        // "<" is escaped so the code can never close the surrounding script element.
        const payload = JSON.stringify({ code, injectGlobals }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
        return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<script src="${lib}"></script>
<script>
const post = msg => parent.postMessage({ __wgp: 1, msg }, '*');
const show = a => {
    let s;
    if (typeof a === 'string') s = a;
    else if (a instanceof Error) s = a.stack || a.message;
    else { try { s = JSON.stringify(a); } catch { s = String(a); } }
    return (s === undefined ? String(a) : s).slice(0, 4000);
};
for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { post({ type: 'log', level, text: args.map(show).join(' ') }); orig(...args); };
}
const lineOf = e => { const m = /user\\.js:(\\d+)/.exec((e && e.stack) || ''); return m ? +m[1] - 2 : null; };
const fail = e => post({ type: 'error', message: String((e && e.message) || e), line: lineOf(e) });
window.addEventListener('error', e => fail(e.error || e.message));
window.addEventListener('unhandledrejection', e => fail(e.reason));
const __cell = (_i, title) => {
    const d = document.createElement('div'); d.className = 'cell-title'; d.textContent = title || 'Output';
    document.body.appendChild(d);
};
(async () => {
    const t0 = performance.now();
    try {
        const { code, injectGlobals } = ${payload};
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const names = injectGlobals ? Object.keys(WebGPUPlot) : [];
        const fn = new AsyncFunction('WebGPUPlot', '__cell', ...names, code + '\\n//# sourceURL=user.js');
        await fn(WebGPUPlot, __cell, ...names.map(n => WebGPUPlot[n]));
        post({ type: 'done', ms: Math.round(performance.now() - t0) });
    } catch (e) { fail(e); }
})();
</script></body></html>`;
    }
}
