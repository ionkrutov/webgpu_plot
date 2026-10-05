// title: Surfaces
import { figure, subplot, surf, mesh, contour3, peaks, title, xlabel, ylabel, zlabel, colorbar, view } from "webgpu-plot";

// %% surf, mesh and contour3 of peaks
figure();
const { X, Y, Z } = peaks(60);

subplot(2, 2, 1);
surf(X, Y, Z, { EdgeColor: "none" });
title("surf");
xlabel("x"); ylabel("y"); zlabel("z");
colorbar("on");

subplot(2, 2, 2);
mesh(X, Y, Z);
title("mesh");

subplot(2, 2, 3);
contour3(X, Y, Z, 16);
view(-30, 40);
title("contour3");

subplot(2, 2, 4);
surf(X, Y, Z, "FaceColor", "interp", "EdgeColor", "none");
title("interpolated shading");

// Drag to rotate, Shift-drag to pan, wheel to zoom, double-click to reset.
