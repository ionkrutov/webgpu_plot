import { Plotter, MarkerStyle, type MarkerShape } from "./plotter";

// ---------------------------------------------------------------------------
// Each series: a horizontal line of evenly-spaced X points at a fixed Y level,
// decorated with a different MATLAB marker shape.
// ---------------------------------------------------------------------------

const SHAPES: Array<{ shape: MarkerShape; label: string; color: [number, number, number] }> = [
    { shape: 'o',         label: 'circle',        color: [0.00, 0.45, 0.74] },
    // { shape: '+',         label: 'plus',           color: [0.85, 0.33, 0.10] },
    // { shape: '*',         label: 'asterisk',       color: [0.93, 0.69, 0.13] },
    // { shape: '.',         label: 'point',          color: [0.49, 0.18, 0.56] },
    // { shape: 'x',         label: 'cross',          color: [0.47, 0.67, 0.19] },
    // { shape: '_',         label: 'hline',          color: [0.30, 0.75, 0.93] },
    // { shape: '|',         label: 'vline',          color: [0.64, 0.08, 0.18] },
    { shape: 'square',    label: 'square',         color: [0.00, 0.45, 0.74] },
    { shape: 'diamond',   label: 'diamond',        color: [0.85, 0.33, 0.10] },
    { shape: '^',         label: 'up-triangle',    color: [0.93, 0.69, 0.13] },
    { shape: 'v',         label: 'down-triangle',  color: [0.49, 0.18, 0.56] },
    { shape: '>',         label: 'right-triangle', color: [0.47, 0.67, 0.19] },
    { shape: '<',         label: 'left-triangle',  color: [0.30, 0.75, 0.93] },
    { shape: 'pentagram', label: 'pentagram',      color: [0.64, 0.08, 0.18] },
    { shape: 'hexagram',  label: 'hexagram',       color: [0.20, 0.60, 0.40] },
];

const N_PTS  = 12;
const X_VALS = Array.from({ length: N_PTS }, (_, i) => i + 1);

async function main() {
    const container = document.getElementById("plot_container") as HTMLElement;
    const plotter   = new Plotter();

    const series = SHAPES.map(({ shape, color }, row) => {
        const y = SHAPES.length - row;   // top row = highest Y value
        const mk = new MarkerStyle();
        mk.shape     = shape;
        mk.size      = 14;
        mk.edgeWidth = 1.5;

        return {
            x: X_VALS,
            y: X_VALS.map(() => y),
            lineStyle: '-'  as const,
            lineWidth: 1,
            marker: mk,
            color,
        };
    });

    plotter.plot(series, {
        title:  "MATLAB marker shapes",
        xlabel: "x",
        ylabel: "series",
    }, container);
}

main();
