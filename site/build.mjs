// Builds the online editor into site/dist. The library comes from WEBGPU_PLOT_DIST (default: ../dist,
// i.e. the build in this repository); point it at node_modules/webgpu-plot/dist after splitting the repository.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const libDist = resolve(here, process.env.WEBGPU_PLOT_DIST ?? '../dist');
const out = join(here, 'dist');

function findMonaco() {
    for (let dir = here; ; dir = dirname(dir)) {
        const p = join(dir, 'node_modules', 'monaco-editor');
        if (existsSync(p)) return p;
        if (dirname(dir) === dir) throw new Error('monaco-editor is not installed; run npm install');
    }
}
const monaco = findMonaco();

for (const f of ['webgpu-plot.iife.js', 'index.d.ts']) {
    if (!existsSync(join(libDist, f))) throw new Error(`${join(libDist, f)} not found; build the library first (npm run build)`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
    entryPoints: {
        main: join(here, 'src/main.ts'),
        'editor.worker': join(monaco, 'esm/vs/editor/editor.worker.js'),
        'ts.worker': join(monaco, 'esm/vs/language/typescript/ts.worker.js'),
    },
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
    outdir: out,
    loader: { '.ttf': 'file' },
    logLevel: 'warning',
});

// The sandboxed runner loads the library as a classic script.
copyFileSync(join(libDist, 'webgpu-plot.iife.js'), join(out, 'webgpu-plot.iife.js'));
copyFileSync(join(here, 'src/index.html'), join(out, 'index.html'));
copyFileSync(join(here, 'src/style.css'), join(out, 'style.css'));

// Type declarations for editor completions: { "index.d.ts": "...", ... }
const types = {};
for (const f of readdirSync(libDist)) {
    if (f.endsWith('.d.ts') && f !== 'demo.d.ts') types[f] = readFileSync(join(libDist, f), 'utf8');
}
writeFileSync(join(out, 'types.json'), JSON.stringify(types));

// Examples: first line "// title: ..." is the menu label.
const exDir = join(here, 'examples');
const examples = readdirSync(exDir).filter(f => f.endsWith('.js')).sort().map(f => {
    const code = readFileSync(join(exDir, f), 'utf8');
    const title = /^\/\/ title:\s*(.+)$/m.exec(code)?.[1] ?? f;
    return { id: f.replace(/\.js$/, ''), title, code: code.replace(/^\/\/ title:.*\n/, '') };
});
writeFileSync(join(out, 'examples.json'), JSON.stringify(examples));

console.log(`site built: ${out} (${examples.length} examples, ${Object.keys(types).length} type files)`);

// Precompressed copies (.gz, .br) for nginx gzip_static / brotli_static: the bundles shrink about 4x.
let saved = 0;
for (const f of process.env.PRECOMPRESS === '0' ? [] : readdirSync(out)) {
    if (!['.js', '.css', '.json', '.html', '.ttf'].includes(extname(f))) continue;
    const data = readFileSync(join(out, f));
    if (data.length < 1024) continue;
    const gz = gzipSync(data, { level: 9 });
    const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
    writeFileSync(join(out, `${f}.gz`), gz);
    writeFileSync(join(out, `${f}.br`), br);
    saved += data.length - br.length;
}
console.log(process.env.PRECOMPRESS === '0' ? 'precompression skipped' : `precompressed (.gz, .br), brotli saves ${(saved / 1048576).toFixed(1)} MB`);
