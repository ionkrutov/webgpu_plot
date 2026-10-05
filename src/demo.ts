import {
    figure, subplot, plot, hold, title, xlabel, ylabel, legend, grid, xlim, sgtitle, linkaxes, gca,
    MarkerStyle,
} from "./index";
import type { MarkerShape } from "./index";

const SHAPES: MarkerShape[] = ['o', 'square', 'diamond', '^', 'v', '>', '<', 'pentagram', 'hexagram', '+', '*', 'x'];

figure("#plot_container", { name: "webgpu-plot demo", width: 1000, height: 760 });
sgtitle("MATLAB-style API on WebGPU");

// 1) format strings, hold on, legend
const t = Array.from({ length: 400 }, (_, i) => i / 20);
subplot(2, 2, 1);
plot(t, t.map(Math.sin), "r-", { LineWidth: 2 });
hold("on");
plot(t, t.map(Math.cos), "b--");
plot(t, t.map(v => Math.sin(v) * Math.cos(v)), "k:");
title("sin / cos");
xlabel("t");
ylabel("amplitude");
legend("sin", "cos", "sin·cos");
const ax1 = gca();

// 2) marker shapes, one row per shape
subplot(2, 2, 2);
const xs = Array.from({ length: 24 }, (_, i) => (i * 20) / 23);
SHAPES.forEach((shape, row) => {
    const mk = new MarkerStyle();
    mk.shape = shape; mk.size = 10; mk.edgeWidth = 1.5;
    plot(xs, xs.map(() => SHAPES.length - row), { Marker: mk, LineStyle: "-", LineWidth: 1 });
    hold("on");
});
title("marker shapes (x linked with the left plot)");
xlabel("x");
const ax2 = gca();

// 3) 200k-point random walk with NaN gaps and an explicit x range
subplot(2, 2, [3, 4]);
const n = 200_000;
const y = new Float32Array(n);
let acc = 0;
for (let i = 0; i < n; i++) { acc += Math.random() - 0.5; y[i] = i % 50_000 === 0 && i > 0 ? NaN : acc; }
plot(y, "-", { Color: "#d95319", LineWidth: 1 });
title("200 000 points with NaN gaps (double-click to reset the view)");
xlabel("sample");
grid("on");
xlim([0, n]);

linkaxes([ax1, ax2], "x");
