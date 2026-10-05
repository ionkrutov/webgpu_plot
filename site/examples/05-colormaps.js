// title: Colormaps
import { figure, subplot, surf, peaks, colormap, title } from "webgpu-plot";

// %% The same surface with different colormaps (append _r to reverse one)
figure();
const { X, Y, Z } = peaks(40);
const names = ["viridis", "plasma", "inferno", "turbo", "coolwarm", "jet"];

names.forEach((name, i) => {
    subplot(2, 3, i + 1);
    surf(X, Y, Z, { EdgeColor: "none" });
    colormap(name);
    title(name);
});
