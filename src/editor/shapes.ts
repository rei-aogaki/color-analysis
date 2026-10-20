// Brush shapes, drawn in a 100 × 100 box. Holes (eyes, nose) are cut out, so the
// monochrome photo shows through them and the animal stays recognizable when large.
export type ShapeName = 'circle' | 'bear' | 'dog';
type Shape = { label: string; spacing: number; body: (path: Path2D) => void; holes?: (path: Path2D) => void };

const ellipse = (path: Path2D, x: number, y: number, rx: number, ry: number, rotation = 0) => {
  path.moveTo(x + rx * Math.cos(rotation), y + rx * Math.sin(rotation)); path.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2); path.closePath();
};

export const SHAPES: Record<ShapeName, Shape> = {
  // Overlapping circles form a continuous line.
  circle: { label: '丸', spacing: 0.12, body: path => ellipse(path, 50, 50, 50, 50) },
  bear: {
    label: 'くま', spacing: 1.15,
    body: path => { ellipse(path, 50, 57, 37, 35); ellipse(path, 20, 25, 15, 15); ellipse(path, 80, 25, 15, 15); },
    holes: path => { ellipse(path, 37, 54, 4.6, 5.2); ellipse(path, 63, 54, 4.6, 5.2); ellipse(path, 50, 70, 7, 5); },
  },
  dog: {
    label: 'わんちゃん', spacing: 1.15,
    body: path => {
      ellipse(path, 50, 47, 31, 30); ellipse(path, 50, 73, 19, 16);
      // Long ears hang down along both sides of the head.
      ellipse(path, 19, 51, 12, 28, 0.32); ellipse(path, 81, 51, 12, 28, -0.32);
    },
    holes: path => { ellipse(path, 39, 45, 4.4, 5); ellipse(path, 61, 45, 4.4, 5); ellipse(path, 50, 66, 7.5, 5.5); },
  },
};

const cache = new Map<ShapeName, { body: Path2D; holes?: Path2D }>();
export function shapePaths(name: ShapeName) {
  let entry = cache.get(name);
  if (!entry) {
    const shape = SHAPES[name], body = new Path2D(); shape.body(body);
    let holes: Path2D | undefined; if (shape.holes) { holes = new Path2D(); shape.holes(holes); }
    entry = { body, holes }; cache.set(name, entry);
  }
  return entry;
}

/** Fill the shape into a size × size area at (x, y) with the current fillStyle. */
export function drawShape(context: CanvasRenderingContext2D, name: ShapeName, x: number, y: number, size: number): void {
  const { body, holes } = shapePaths(name);
  context.save(); context.translate(x, y); context.scale(size / 100, size / 100);
  context.fill(body, 'nonzero');
  if (holes) { context.globalCompositeOperation = 'destination-out'; context.fill(holes); }
  context.restore();
}
