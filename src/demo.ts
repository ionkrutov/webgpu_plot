import {
    figure, subplot, plot, hold, title, xlabel, ylabel, zlabel, legend, grid, xlim, sgtitle, linkaxes, gca,
    plot3, scatter3, surf, mesh, contour3, colorbar, view, linspace, peaks,
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

// ---- 3-D: drag to rotate, Shift-drag to pan, wheel to zoom, double-click to reset ----
figure("#plot_container", { name: "webgpu-plot 3-D demo", width: 1000, height: 760 });
sgtitle("3-D plots: surf, mesh, plot3 / scatter3, contour3");

const { X, Y, Z } = peaks(60);

subplot(2, 2, 1);
surf(X, Y, Z, { EdgeColor: "none" });
title("surf");
xlabel("x"); ylabel("y"); zlabel("z");
colorbar("on");

subplot(2, 2, 2);
mesh(X, Y, Z);
title("mesh");
xlabel("x"); ylabel("y"); zlabel("z");

subplot(2, 2, 3);
const s = linspace(0, 8 * Math.PI, 600);
plot3(s.map(Math.cos), s.map(Math.sin), s.map(v => v / 4), "r-", { LineWidth: 2 });
hold("on");
const sx = linspace(0, 6 * Math.PI, 80);
scatter3(sx.map(v => 1.5 * Math.cos(v)), sx.map(v => 1.5 * Math.sin(v)), sx.map(v => v / 3), 36, sx, "filled");
title("plot3 + scatter3");
xlabel("x"); ylabel("y"); zlabel("z");

subplot(2, 2, 4);
contour3(X, Y, Z, 16);
view(-30, 40);
title("contour3");
xlabel("x"); ylabel("y"); zlabel("z");
