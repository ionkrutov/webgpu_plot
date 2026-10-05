/** n evenly spaced values from a to b (inclusive). */
export function linspace(a: number, b: number, n = 100): number[] {
    if (n < 2) return [b];
    return Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
}

/** Coordinate matrices (rows = y, columns = x) for vectors x and y, as MATLAB's meshgrid. */
export function meshgrid(x: ArrayLike<number>, y: ArrayLike<number> = x): { X: number[][]; Y: number[][] } {
    const X: number[][] = [], Y: number[][] = [];
    for (let i = 0; i < y.length; i++) {
        X.push(Array.from(x));
        Y.push(Array.from({ length: x.length }, () => y[i]!));
    }
    return { X, Y };
}

/** MATLAB's peaks test surface on an n × n grid over [-3, 3]². */
export function peaks(n = 49): { X: number[][]; Y: number[][]; Z: number[][] } {
    const { X, Y } = meshgrid(linspace(-3, 3, n));
    const Z = X.map((row, i) => row.map((x, j) => {
        const y = Y[i]![j]!;
        return 3 * (1 - x) ** 2 * Math.exp(-(x ** 2) - (y + 1) ** 2)
            - 10 * (x / 5 - x ** 3 - y ** 5) * Math.exp(-(x ** 2) - y ** 2)
            - Math.exp(-((x + 1) ** 2) - y ** 2) / 3;
    }));
    return { X, Y, Z };
}
