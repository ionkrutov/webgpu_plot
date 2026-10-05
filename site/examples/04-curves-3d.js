// title: 3D curves and points
import { figure, plot3, scatter3, hold, title, xlabel, ylabel, zlabel, linspace, colorbar, colormap } from "webgpu-plot";

// %% A helix with coloured points
figure();
const s = linspace(0, 8 * Math.PI, 600);
plot3(s.map(Math.cos), s.map(Math.sin), s.map(v => v / 4), "r-", { LineWidth: 2 });
hold("on");

const p = linspace(0, 6 * Math.PI, 80);
// The colour argument is a vector of values mapped through the colormap.
scatter3(p.map(v => 1.5 * Math.cos(v)), p.map(v => 1.5 * Math.sin(v)), p.map(v => v / 3), 36, p, "filled");
colormap("plasma");
colorbar("on");

title("plot3 + scatter3");
xlabel("x"); ylabel("y"); zlabel("z");
