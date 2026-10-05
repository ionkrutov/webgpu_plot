// title: 2D basics
import { figure, subplot, plot, hold, title, xlabel, ylabel, legend, grid, linspace } from "webgpu-plot";

// %% Lines, formats and a legend
figure();
const t = linspace(0, 20, 400);
plot(t, t.map(Math.sin), "r-", { LineWidth: 2 });
hold("on");
plot(t, t.map(Math.cos), "b--");
plot(t, t.map(v => Math.sin(v) * Math.cos(v)), "k:");
title("sin / cos");
xlabel("t");
ylabel("amplitude");
legend("sin", "cos", "sin·cos");
grid("on");

// %% Subplots with markers
figure();
const x = linspace(0, 2 * Math.PI, 30);

subplot(2, 1, 1);
plot(x, x.map(Math.sin), "o-");
title("sin, circles");

subplot(2, 1, 2);
plot(x, x.map(Math.cos), "sr--");
title("cos, squares");
xlabel("x");

// Drag to pan, wheel to zoom, double-click to reset the view.
