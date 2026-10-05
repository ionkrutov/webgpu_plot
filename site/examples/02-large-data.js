// title: 200 000 points
import { figure, plot, title, xlabel, grid, xlim } from "webgpu-plot";

// %% Random walk with gaps (NaN breaks the line)
figure();
const n = 200_000;
const y = new Float32Array(n);
let acc = 0;
for (let i = 0; i < n; i++) {
    acc += Math.random() - 0.5;
    y[i] = i % 50_000 === 0 && i > 0 ? NaN : acc;
}
plot(y, "-", { Color: "#d95319", LineWidth: 1 });
title("200 000 points, still smooth to pan and zoom");
xlabel("sample");
grid("on");
xlim([0, n]);
