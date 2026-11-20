/** Rectangle maths for layout measurement. All values are CSS pixels in document coordinates. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectArea(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Area covered by a set of rectangles, counting overlaps once.
 * Coordinate compression: fine for the few dozen rectangles on a results page.
 */
export function unionArea(rects: readonly Rect[]): number {
  const live = rects.filter((r) => r.width > 0 && r.height > 0);
  if (live.length === 0) return 0;
  if (live.length === 1) return rectArea(live[0]!);
  const xs = [...new Set(live.flatMap((r) => [r.x, r.x + r.width]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const left = xs[i]!;
    const right = xs[i + 1]!;
    const spans = live
      .filter((r) => r.x <= left && r.x + r.width >= right)
      .map((r) => [r.y, r.y + r.height] as const)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = -Infinity;
    for (const [top, bottom] of spans) {
      if (bottom <= end) continue;
      covered += bottom - Math.max(top, end);
      end = bottom;
    }
    area += covered * (right - left);
  }
  return area;
}

export function roundRect(rect: Rect): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}
