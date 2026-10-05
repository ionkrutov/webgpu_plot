const STYLE_ID = 'wgp-styles';

const CSS = `
.wgp-window, .wgp-window * { box-sizing: border-box; }
.wgp-window {
    display: flex; flex-direction: column;
    width: 820px; height: 640px; min-width: 240px; min-height: 180px;
    resize: both; overflow: hidden;
    border: 1px solid #888; border-radius: 7px;
    background: #fff;
    box-shadow: 0 6px 24px rgba(0,0,0,0.30);
    font-family: sans-serif;
}
.wgp-window.wgp-embedded { resize: none; border: none; border-radius: 0; box-shadow: none; }
.wgp-header {
    display: flex; align-items: center; gap: 8px; padding: 5px 8px; flex-shrink: 0;
    background: #e8e8e8; border-bottom: 1px solid #c0c0c0; user-select: none;
}
.wgp-title { flex: 1; font-size: 13px; font-weight: 600; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wgp-toolbar { display: flex; flex-direction: row; gap: 4px; }
.wgp-btn {
    width: 30px; height: 30px; padding: 0; background: #fff; border: 1px solid #bbb; border-radius: 5px;
    cursor: pointer; font-size: 18px; line-height: 1; color: #222;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 1px 3px rgba(0,0,0,0.18); user-select: none; transition: background 0.1s;
}
.wgp-btn:hover  { background: #f5f8ff; }
.wgp-btn:active { background: #d2e1ff; }
.wgp-btn.wgp-active { background: #b4d2ff; border-color: #4477cc; }
.wgp-select {
    height: 30px; border: 1px solid #bbb; border-radius: 5px; background: #fff; font-size: 12px;
    padding: 0 6px; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.18); max-width: 200px;
}
.wgp-save { position: relative; display: inline-flex; }
.wgp-save-menu {
    display: none; position: absolute; top: calc(100% + 3px); right: 0; z-index: 200;
    background: #fff; border: 1px solid #bbb; border-radius: 5px; box-shadow: 0 3px 10px rgba(0,0,0,0.25);
    overflow: hidden; white-space: nowrap;
}
.wgp-save-menu.wgp-open { display: block; }
.wgp-save-item {
    display: block; width: 100%; padding: 7px 18px; background: none; border: none; border-bottom: 1px solid #eee;
    text-align: left; cursor: pointer; font-size: 13px; font-family: sans-serif; color: #333;
}
.wgp-save-item:last-child { border-bottom: none; }
.wgp-save-item:hover { background: #f0f4ff; }
.wgp-canvas-container { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.wgp-canvas { display: block; width: 100%; height: 100%; }
.wgp-zoom-rect {
    position: absolute; display: none; pointer-events: none; z-index: 5;
    border: 2px dashed rgba(30,100,220,0.9); background: rgba(30,100,220,0.10);
}
.wgp-crosshair-v, .wgp-crosshair-h { position: absolute; display: none; pointer-events: none; background: rgba(0,0,0,0.4); }
.wgp-crosshair-v { width: 1px; transform: translateX(-0.5px); }
.wgp-crosshair-h { height: 1px; transform: translateY(-0.5px); }
.wgp-tooltip {
    position: absolute; display: none; pointer-events: none; z-index: 10;
    background: rgba(20,20,20,0.85); color: #fff; font: 12px/1.6 monospace; padding: 5px 9px;
    border-radius: 5px; white-space: pre; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
.wgp-error {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    padding: 16px; text-align: center; color: #a00; font-size: 14px; background: #fff;
}
`;

/** Injects the library stylesheet once per document. */
export function injectStyles(): void {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.prepend(el);
}
