import {
  absolutePolygonArea,
  bboxOfPoints,
  cleanPolygon,
  pointInPolygon,
  signedPolygonArea,
  simplifyCollinear
} from './geometry.js';

const EPS = 1e-7;

function uniqueSorted(values, tolerance = 1e-5) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  for (const value of sorted) {
    if (!out.length || Math.abs(value - out[out.length - 1]) > tolerance) out.push(value);
  }
  return out;
}

export function orthogonalizePolygon(points = [], tolerance = 2) {
  const output = cleanPolygon(points).map((point) => ({ ...point }));
  if (output.length < 3) return output;
  for (let pass = 0; pass < 3; pass += 1) {
    for (let index = 0; index < output.length; index += 1) {
      const nextIndex = (index + 1) % output.length;
      const a = output[index];
      const b = output[nextIndex];
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      if (dx <= tolerance && dy > tolerance) {
        const x = (a.x + b.x) / 2;
        a.x = x; b.x = x;
      } else if (dy <= tolerance && dx > tolerance) {
        const y = (a.y + b.y) / 2;
        a.y = y; b.y = y;
      }
    }
  }
  return simplifyCollinear(cleanPolygon(output), 0.01);
}

export function isOrthogonalPolygon(points = [], tolerance = 2) {
  const polygon = cleanPolygon(points);
  if (polygon.length < 3) return false;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    if (Math.abs(a.x - b.x) > tolerance && Math.abs(a.y - b.y) > tolerance) return false;
  }
  return true;
}

export function pointInRegion(point, region) {
  if (!pointInPolygon(point, region.polygon || [])) return false;
  return !(region.holes || []).some((hole) => pointInPolygon(point, hole));
}

export function cellsForRegion(region, { orthogonalTolerance = 2 } = {}) {
  const polygon = orthogonalizePolygon(region.polygon || [], orthogonalTolerance);
  const holes = (region.holes || []).map((hole) => orthogonalizePolygon(hole, orthogonalTolerance));
  if (polygon.length < 3 || !isOrthogonalPolygon(polygon, orthogonalTolerance)) return null;
  const xs = [];
  const ys = [];
  for (const point of polygon) { xs.push(point.x); ys.push(point.y); }
  for (const hole of holes) for (const point of hole) { xs.push(point.x); ys.push(point.y); }
  const xValues = uniqueSorted(xs);
  const yValues = uniqueSorted(ys);
  const cells = [];
  for (let ix = 0; ix < xValues.length - 1; ix += 1) {
    const minX = xValues[ix]; const maxX = xValues[ix + 1];
    if (maxX - minX <= EPS) continue;
    for (let iy = 0; iy < yValues.length - 1; iy += 1) {
      const minY = yValues[iy]; const maxY = yValues[iy + 1];
      if (maxY - minY <= EPS) continue;
      const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      if (!pointInRegion(center, { polygon, holes })) continue;
      cells.push({ ix, iy, minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY });
    }
  }
  return { polygon, holes, xValues, yValues, cells };
}

function edgeKey(a, b) {
  return `${a.x.toFixed(6)},${a.y.toFixed(6)}>${b.x.toFixed(6)},${b.y.toFixed(6)}`;
}

function vertexKey(point) {
  return `${point.x.toFixed(6)},${point.y.toFixed(6)}`;
}

export function boundaryLoopsFromRectangles(rectangles = []) {
  const xs = uniqueSorted(rectangles.flatMap((rect) => [rect.minX, rect.maxX]));
  const ys = uniqueSorted(rectangles.flatMap((rect) => [rect.minY, rect.maxY]));
  const occupied = new Set();
  for (let ix = 0; ix < xs.length - 1; ix += 1) {
    for (let iy = 0; iy < ys.length - 1; iy += 1) {
      const center = { x: (xs[ix] + xs[ix + 1]) / 2, y: (ys[iy] + ys[iy + 1]) / 2 };
      if (rectangles.some((rect) => center.x > rect.minX - EPS && center.x < rect.maxX + EPS
        && center.y > rect.minY - EPS && center.y < rect.maxY + EPS)) occupied.add(`${ix}:${iy}`);
    }
  }

  const edges = new Map();
  const add = (a, b) => {
    const reverse = edgeKey(b, a);
    if (edges.has(reverse)) edges.delete(reverse);
    else edges.set(edgeKey(a, b), { a, b });
  };
  for (const key of occupied) {
    const [ix, iy] = key.split(':').map(Number);
    const p0 = { x: xs[ix], y: ys[iy] };
    const p1 = { x: xs[ix + 1], y: ys[iy] };
    const p2 = { x: xs[ix + 1], y: ys[iy + 1] };
    const p3 = { x: xs[ix], y: ys[iy + 1] };
    add(p0, p1); add(p1, p2); add(p2, p3); add(p3, p0);
  }

  const outgoing = new Map();
  for (const edge of edges.values()) {
    const list = outgoing.get(vertexKey(edge.a)) || [];
    list.push(edge);
    outgoing.set(vertexKey(edge.a), list);
  }
  const unused = new Set(edges.keys());
  const loops = [];
  while (unused.size) {
    const firstKey = unused.values().next().value;
    const first = edges.get(firstKey);
    let current = first;
    const loop = [first.a];
    unused.delete(firstKey);
    let guard = 0;
    while (guard++ < edges.size + 10) {
      loop.push(current.b);
      if (vertexKey(current.b) === vertexKey(first.a)) break;
      const candidates = (outgoing.get(vertexKey(current.b)) || [])
        .filter((edge) => unused.has(edgeKey(edge.a, edge.b)));
      if (!candidates.length) break;
      current = candidates[0];
      unused.delete(edgeKey(current.a, current.b));
    }
    const cleaned = simplifyCollinear(cleanPolygon(loop), 0.01);
    if (cleaned.length >= 3 && absolutePolygonArea(cleaned) > 0.1) loops.push(cleaned);
  }
  return loops;
}

export function connectedRectangleGroups(rectangles = [], tolerance = 1e-6) {
  const remaining = new Set(rectangles.map((_, index) => index));
  const groups = [];
  const touches = (a, b) => {
    const xOverlap = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const yOverlap = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
    const verticalTouch = Math.abs(a.maxX - b.minX) <= tolerance || Math.abs(b.maxX - a.minX) <= tolerance;
    const horizontalTouch = Math.abs(a.maxY - b.minY) <= tolerance || Math.abs(b.maxY - a.minY) <= tolerance;
    return (verticalTouch && yOverlap > tolerance) || (horizontalTouch && xOverlap > tolerance)
      || (xOverlap > tolerance && yOverlap > tolerance);
  };
  while (remaining.size) {
    const start = remaining.values().next().value;
    remaining.delete(start);
    const queue = [start];
    const group = [];
    while (queue.length) {
      const index = queue.pop();
      group.push(rectangles[index]);
      for (const candidate of [...remaining]) {
        if (!touches(rectangles[index], rectangles[candidate])) continue;
        remaining.delete(candidate);
        queue.push(candidate);
      }
    }
    groups.push(group);
  }
  return groups;
}

export function polygonsFromRectangles(rectangles = []) {
  const output = [];
  for (const group of connectedRectangleGroups(rectangles)) {
    const loops = boundaryLoopsFromRectangles(group);
    const outerLoops = loops.filter((loop) => signedPolygonArea(loop) > 0);
    const innerLoops = loops.filter((loop) => signedPolygonArea(loop) < 0).map((loop) => [...loop].reverse());
    for (const polygon of outerLoops) {
      const holes = innerLoops.filter((hole) => pointInPolygon(hole[0], polygon));
      output.push({ polygon, holes, area: absolutePolygonArea(polygon) - holes.reduce((sum, hole) => sum + absolutePolygonArea(hole), 0) });
    }
  }
  return output;
}

export function intersectRegionCellsWithRect(prepared, rect) {
  if (!prepared?.cells) return null;
  const fragments = [];
  for (const cell of prepared.cells) {
    const minX = Math.max(cell.minX, rect.minX);
    const maxX = Math.min(cell.maxX, rect.maxX);
    const minY = Math.max(cell.minY, rect.minY);
    const maxY = Math.min(cell.maxY, rect.maxY);
    if (maxX - minX <= EPS || maxY - minY <= EPS) continue;
    fragments.push({ minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY });
  }
  return polygonsFromRectangles(fragments);
}

export function preparedRegionBBox(prepared) {
  return bboxOfPoints(prepared?.polygon || []);
}
