import {
  absolutePolygonArea,
  bboxOfPoints,
  bboxesIntersect,
  cleanPolygon,
  pointInPolygon,
  signedPolygonArea,
  simplifyCollinear
} from './geometry.js';
import { orthogonalizePolygon } from './orthogonal-geometry.js';

const EPS = 1e-6;

function normalized(value) {
  return String(value || '').trim().toUpperCase();
}

function uniqueSorted(values, tolerance = 1e-5) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  for (const value of sorted) {
    if (!out.length || Math.abs(value - out[out.length - 1]) > tolerance) out.push(value);
  }
  return out;
}

function rectFromBand(band) {
  return {
    minX: Number(band.minX), minY: Number(band.minY),
    maxX: Number(band.maxX), maxY: Number(band.maxY),
    width: Number(band.maxX) - Number(band.minX),
    height: Number(band.maxY) - Number(band.minY)
  };
}

function pointInRegion(point, component) {
  if (!pointInPolygon(point, component.polygon || [])) return false;
  return !(component.holes || []).some((hole) => pointInPolygon(point, hole));
}

function pointInRect(point, rect, tolerance = 0) {
  return point.x > rect.minX + tolerance && point.x < rect.maxX - tolerance
    && point.y > rect.minY + tolerance && point.y < rect.maxY - tolerance;
}

function isAxisAlignedStrip(points, box) {
  const thin = Math.min(box.width, box.height);
  if (!Number.isFinite(thin) || thin <= 0) return false;
  // HATCH polyline vertices are not guaranteed to be returned in perimeter
  // order. Check the actual boundary against the four bbox corners/edges
  // instead of using signed area, which would reject valid crossed ordering.
  const tolerance = Math.max(2, thin * 0.45);
  const corners = [
    { x: box.minX, y: box.minY }, { x: box.minX, y: box.maxY },
    { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }
  ];
  const cornerCovered = corners.every((corner) => points.some((point) =>
    Math.hypot(point.x - corner.x, point.y - corner.y) <= tolerance));
  if (!cornerCovered) return false;
  return points.every((point) => Math.min(
    Math.abs(point.x - box.minX), Math.abs(point.x - box.maxX),
    Math.abs(point.y - box.minY), Math.abs(point.y - box.maxY)
  ) <= tolerance);
}

/**
 * Detects only explicitly drafted expansion-joint HATCH strips. The rule is
 * intentionally strict so ordinary 1–5 mm linework and unrelated floor-finish
 * HATCH never become joints.
 */
export function detectExpansionJointBands(cad, {
  layerPattern = /^RRIA\s*-\s*FLOOR\s*FINISH$/i,
  hatchPattern = /^ANSI32$/i,
  nominalWidth = 20,
  widthTolerance = 0.75,
  minimumLength = 250,
  minimumAspectRatio = 8
} = {}) {
  const output = [];
  for (const entity of cad?.entities || []) {
    if (entity.type !== 'HATCH') continue;
    if (!layerPattern.test(String(entity.layer || ''))) continue;
    if (!hatchPattern.test(String(entity.patternName || ''))) continue;
    for (let pathIndex = 0; pathIndex < (entity.boundaryPaths || []).length; pathIndex += 1) {
      const path = entity.boundaryPaths[pathIndex];
      const points = cleanPolygon(path.points || path || []);
      if (points.length < 3) continue;
      const box = bboxOfPoints(points);
      const thin = Math.min(box.width, box.height);
      const long = Math.max(box.width, box.height);
      if (Math.abs(thin - nominalWidth) > widthTolerance) continue;
      if (long < minimumLength || long / Math.max(thin, EPS) < minimumAspectRatio) continue;
      if (!isAxisAlignedStrip(points, box)) continue;
      const axis = box.width <= box.height ? 'x' : 'y';
      output.push({
        id: `joint-${entity.handle || 'h'}-${pathIndex}`,
        type: `${nominalWidth}mm 伸縮縫`,
        axis,
        minX: box.minX,
        minY: box.minY,
        maxX: box.maxX,
        maxY: box.maxY,
        width: thin,
        length: long,
        global: true,
        enabled: true,
        visible: true,
        source: 'dxf-joint-hatch',
        sourceLayer: entity.layer || '',
        sourcePattern: entity.patternName || '',
        sourceHandle: entity.handle || '',
        sourcePathIndex: pathIndex,
        polygon: points
      });
    }
  }
  return mergeCollinearJointBands(output, widthTolerance);
}

export function mergeCollinearJointBands(bands, tolerance = 0.75, maximumGap = 400) {
  const sorted = [...(bands || [])].sort((a, b) => a.axis.localeCompare(b.axis)
    || (a.axis === 'x'
      ? (a.minX + a.maxX) - (b.minX + b.maxX) || a.minY - b.minY
      : (a.minY + a.maxY) - (b.minY + b.maxY) || a.minX - b.minX));
  const merged = [];
  for (const band of sorted) {
    const center = band.axis === 'x' ? (band.minX + band.maxX) / 2 : (band.minY + band.maxY) / 2;
    const start = band.axis === 'x' ? band.minY : band.minX;
    const end = band.axis === 'x' ? band.maxY : band.maxX;
    const match = merged.find((item) => item.axis === band.axis
      && Math.abs(item._center - center) <= tolerance
      && start <= item._end + maximumGap
      && end >= item._start - maximumGap);
    if (!match) {
      merged.push({
        ...band,
        sourceIds: [band.id],
        sourceHandles: [band.sourceHandle],
        _center: center,
        _start: start,
        _end: end
      });
      continue;
    }
    match._start = Math.min(match._start, start);
    match._end = Math.max(match._end, end);
    match.sourceIds.push(band.id);
    match.sourceHandles.push(band.sourceHandle);
    if (match.axis === 'x') {
      const half = Math.max(match.width, band.width) / 2;
      match.minX = match._center - half;
      match.maxX = match._center + half;
      match.minY = match._start;
      match.maxY = match._end;
    } else {
      const half = Math.max(match.width, band.width) / 2;
      match.minY = match._center - half;
      match.maxY = match._center + half;
      match.minX = match._start;
      match.maxX = match._end;
    }
    match.length = match._end - match._start;
  }
  return merged.map((item, index) => {
    const { _center, _start, _end, ...band } = item;
    const polygon = [
      { x: band.minX, y: band.minY },
      { x: band.maxX, y: band.minY },
      { x: band.maxX, y: band.maxY },
      { x: band.minX, y: band.maxY }
    ];
    return { ...band, polygon, id: `joint-${String(index + 1).padStart(3, '0')}` };
  });
}

function edgeKey(a, b) {
  return `${a.x.toFixed(6)},${a.y.toFixed(6)}>${b.x.toFixed(6)},${b.y.toFixed(6)}`;
}

function vertexKey(point) {
  return `${point.x.toFixed(6)},${point.y.toFixed(6)}`;
}

function boundaryLoopsFromCells(cells) {
  const edges = new Map();
  const addEdge = (a, b) => {
    const reverse = edgeKey(b, a);
    if (edges.has(reverse)) edges.delete(reverse);
    else edges.set(edgeKey(a, b), { a, b });
  };
  for (const cell of cells) {
    const p0 = { x: cell.minX, y: cell.minY };
    const p1 = { x: cell.maxX, y: cell.minY };
    const p2 = { x: cell.maxX, y: cell.maxY };
    const p3 = { x: cell.minX, y: cell.maxY };
    addEdge(p0, p1);
    addEdge(p1, p2);
    addEdge(p2, p3);
    addEdge(p3, p0);
  }

  const outgoing = new Map();
  for (const edge of edges.values()) {
    const key = vertexKey(edge.a);
    const list = outgoing.get(key) || [];
    list.push(edge);
    outgoing.set(key, list);
  }

  const unused = new Set(edges.keys());
  const loops = [];
  while (unused.size) {
    const firstKey = unused.values().next().value;
    const first = edges.get(firstKey);
    const loop = [first.a];
    let current = first;
    unused.delete(firstKey);
    let guard = 0;
    while (guard++ < edges.size + 5) {
      loop.push(current.b);
      if (vertexKey(current.b) === vertexKey(first.a)) break;
      const candidates = (outgoing.get(vertexKey(current.b)) || [])
        .filter((edge) => unused.has(edgeKey(edge.a, edge.b)));
      if (!candidates.length) break;
      current = candidates[0];
      unused.delete(edgeKey(current.a, current.b));
    }
    const cleaned = simplifyCollinear(cleanPolygon(loop), 1e-5);
    if (cleaned.length >= 3 && absolutePolygonArea(cleaned) > 1) loops.push(cleaned);
  }
  return loops;
}

function connectedCellGroups(cells) {
  const byIndex = new Map(cells.map((cell) => [`${cell.ix}:${cell.iy}`, cell]));
  const remaining = new Set(byIndex.keys());
  const groups = [];
  while (remaining.size) {
    const startKey = remaining.values().next().value;
    remaining.delete(startKey);
    const queue = [byIndex.get(startKey)];
    const group = [];
    while (queue.length) {
      const cell = queue.pop();
      group.push(cell);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${cell.ix + dx}:${cell.iy + dy}`;
        if (!remaining.has(key)) continue;
        remaining.delete(key);
        queue.push(byIndex.get(key));
      }
    }
    groups.push(group);
  }
  return groups;
}

function splitOneComponent(component, bands, { minimumCellArea = 0.01, jointEndExtension = 5 } = {}) {
  const outer = orthogonalizePolygon(component.polygon || [], 2);
  if (outer.length < 3) return [];
  const holes = (component.holes || []).map((hole) => orthogonalizePolygon(hole, 2)).filter((hole) => hole.length >= 3);
  const box = bboxOfPoints(outer);
  const relevant = (bands || []).filter((band) => band.enabled !== false && bboxesIntersect(box, rectFromBand(band), jointEndExtension));
  const cutBands = relevant.map((band) => band.axis === 'x'
    ? { ...band, minY: band.minY - jointEndExtension, maxY: band.maxY + jointEndExtension }
    : { ...band, minX: band.minX - jointEndExtension, maxX: band.maxX + jointEndExtension });
  if (!relevant.length) return [{ ...component, polygon: outer, holes, splitByJointIds: [] }];

  const xs = [box.minX, box.maxX];
  const ys = [box.minY, box.maxY];
  for (const point of outer) { xs.push(point.x); ys.push(point.y); }
  for (const hole of holes) for (const point of hole) { xs.push(point.x); ys.push(point.y); }
  for (const band of cutBands) {
    xs.push(Math.max(box.minX, band.minX), Math.min(box.maxX, band.maxX));
    ys.push(Math.max(box.minY, band.minY), Math.min(box.maxY, band.maxY));
  }
  const xValues = uniqueSorted(xs);
  const yValues = uniqueSorted(ys);
  const cells = [];
  const removedBy = new Set();
  for (let ix = 0; ix < xValues.length - 1; ix += 1) {
    const minX = xValues[ix]; const maxX = xValues[ix + 1];
    if (maxX - minX <= EPS) continue;
    for (let iy = 0; iy < yValues.length - 1; iy += 1) {
      const minY = yValues[iy]; const maxY = yValues[iy + 1];
      if ((maxX - minX) * (maxY - minY) <= minimumCellArea) continue;
      const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      if (!pointInRegion(center, { polygon: outer, holes })) continue;
      const cutBand = cutBands.find((band) => pointInRect(center, band, -EPS));
      if (cutBand) { removedBy.add(cutBand.id); continue; }
      cells.push({ ix, iy, minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY });
    }
  }
  if (!cells.length) return [];
  if (!removedBy.size) return [{ ...component, polygon: outer, holes, splitByJointIds: [] }];

  const output = [];
  for (const cellGroup of connectedCellGroups(cells)) {
    const loops = boundaryLoopsFromCells(cellGroup);
    const outers = loops.filter((loop) => signedPolygonArea(loop) > 0);
    const innerLoops = loops.filter((loop) => signedPolygonArea(loop) < 0).map((loop) => [...loop].reverse());
    for (const polygon of outers) {
      const componentHoles = innerLoops.filter((hole) => pointInPolygon(hole[0], polygon));
      output.push({
        ...component,
        polygon,
        holes: componentHoles,
        splitByJointIds: [...removedBy]
      });
    }
  }
  return output.length ? output : [{ ...component, polygon: outer, holes, splitByJointIds: [] }];
}

/**
 * Splits each HATCH component into the minimum connected tiled regions after
 * subtracting the strictly detected joint strips. Base order is preserved so
 * users continue to see familiar labels such as 72-A, 72-B, 72-C.
 */
export function splitHatchComponentsByBands(components, bands, options) {
  const output = [];
  for (let baseIndex = 0; baseIndex < (components || []).length; baseIndex += 1) {
    const component = components[baseIndex];
    const pieces = splitOneComponent(component, bands, options)
      .sort((a, b) => {
        const boxA = bboxOfPoints(a.polygon);
        const boxB = bboxOfPoints(b.polygon);
        return boxB.maxY - boxA.maxY || boxA.minX - boxB.minX;
      });
    for (let splitIndex = 0; splitIndex < pieces.length; splitIndex += 1) {
      output.push({
        ...pieces[splitIndex],
        baseIndex,
        splitIndex,
        splitCount: pieces.length
      });
    }
  }
  return output;
}

export function countBandsIntersectingComponent(component, bands) {
  const box = bboxOfPoints(component.polygon || []);
  return (bands || []).filter((band) => {
    if (!bboxesIntersect(box, band, 0.01)) return false;
    const samples = [
      { x: (band.minX + band.maxX) / 2, y: (band.minY + band.maxY) / 2 },
      { x: band.minX, y: band.minY },
      { x: band.maxX, y: band.maxY }
    ];
    return samples.some((point) => pointInRegion(point, component));
  }).length;
}
