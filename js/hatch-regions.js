import {
  absolutePolygonArea,
  bboxOfPoints,
  cleanPolygon,
  pointInPolygon
} from './geometry.js';

function normalizedLayerName(name) {
  return String(name || '0').trim().toUpperCase();
}

export function hatchEntitiesOnLayer(cad, layerName) {
  const target = normalizedLayerName(layerName);
  return (cad?.entities || []).filter((entity) => entity.type === 'HATCH'
    && normalizedLayerName(entity.layer) === target
    && (entity.boundaryPaths || []).length);
}

export function inferAreaHatchLayer(cad) {
  const layers = cad?.layers || [];
  const explicit = layers.find((layer) => Number(layer.hatches || 0) > 0
    && /^(ROOF[ _-]*TILE|ROOF[ _-]*TILE[ _-]*(AREA|HATCH|ZONE))$/i.test(layer.name));
  if (explicit) return explicit.name;

  const grouped = new Map();
  for (const entity of cad?.entities || []) {
    if (entity.type !== 'HATCH' || !(entity.boundaryPaths || []).length) continue;
    const key = entity.layer || '0';
    const current = grouped.get(key) || {
      layer: key,
      count: 0,
      patterns: new Map(),
      totalArea: 0,
      usefulPaths: 0
    };
    current.count += 1;
    current.patterns.set(entity.patternName || '', (current.patterns.get(entity.patternName || '') || 0) + 1);
    current.totalArea += absolutePolygonArea(entity.points || []);
    current.usefulPaths += (entity.boundaryPaths || []).filter((path) => !(Number(path.flags || 0) & 8)).length;
    grouped.set(key, current);
  }

  const scored = [...grouped.values()].map((item) => {
    let score = item.count * 100 + item.usefulPaths * 25 + Math.log10(Math.max(1, item.totalArea));
    if ([...item.patterns.keys()].some((pattern) => /AR-B816C/i.test(pattern))) score += 100000;
    if (/ROOF[ _-]*TILE/i.test(item.layer)) score += 50000;
    if (/SEAL/i.test(item.layer)) score += 5000;
    if (/RRIA|FLOOR[ _-]*FINISH|RWP|TXT|VG_HATCH/i.test(item.layer)) score -= 50000;
    return { ...item, score };
  }).sort((a, b) => b.score - a.score);

  return scored[0]?.layer || layers.find((layer) => Number(layer.hatches || 0) > 0)?.name || '';
}

function pathContainmentSample(path) {
  const first = path.points[0];
  if (!first) return { x: 0, y: 0 };
  const box = bboxOfPoints(path.points);
  const towardCenter = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  // Move a tiny distance away from the boundary vertex. This avoids treating a
  // shared endpoint as an interior point while preserving behaviour for concave loops.
  return {
    x: first.x + (towardCenter.x - first.x) * 1e-7,
    y: first.y + (towardCenter.y - first.y) * 1e-7
  };
}

export function extractHatchComponents(entity, { minimumArea = 100, ignoreTextBoxes = true } = {}) {
  const paths = (entity?.boundaryPaths || [])
    .map((path, index) => {
      const points = cleanPolygon(path.points || path || []);
      return {
        index,
        flags: Number(path.flags || 0),
        points,
        area: absolutePolygonArea(points),
        parent: null,
        depth: 0
      };
    })
    .filter((path) => path.points.length >= 3
      && path.area > minimumArea
      && (!ignoreTextBoxes || !(path.flags & 8)));

  for (const path of paths) {
    const sample = pathContainmentSample(path);
    const parents = paths
      .filter((candidate) => candidate !== path
        && candidate.area > path.area + 1
        && pointInPolygon(sample, candidate.points))
      .sort((a, b) => a.area - b.area);
    path.parent = parents[0] || null;
  }

  const depthOf = (path, visited = new Set()) => {
    if (!path.parent || visited.has(path)) return 0;
    visited.add(path);
    return 1 + depthOf(path.parent, visited);
  };
  for (const path of paths) path.depth = depthOf(path);

  return paths.filter((path) => path.depth % 2 === 0).map((outer) => ({
    polygon: outer.points,
    holes: paths
      .filter((path) => path.parent === outer && path.depth % 2 === 1)
      .map((path) => path.points),
    sourceHandle: entity.handle || '',
    sourceLayer: entity.layer || '',
    sourcePattern: entity.patternName || '',
    sourcePathIndex: outer.index
  }));
}


function squaredDistanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return (point.x - a.x) ** 2 + (point.y - a.y) ** 2;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  const x = a.x + t * dx;
  const y = a.y + t * dy;
  return (point.x - x) ** 2 + (point.y - y) ** 2;
}

function pointOnPolygonBoundary(point, polygon, tolerance = 0.5) {
  const limit = tolerance * tolerance;
  for (let index = 0; index < polygon.length; index += 1) {
    if (squaredDistanceToSegment(point, polygon[index], polygon[(index + 1) % polygon.length]) <= limit) return true;
  }
  return false;
}

function pointInOrOnPolygon(point, polygon, tolerance = 0.5) {
  return pointInPolygon(point, polygon) || pointOnPolygonBoundary(point, polygon, tolerance);
}

function pointInComponent(point, component, tolerance = 0.5) {
  if (!pointInOrOnPolygon(point, component.polygon, tolerance)) return false;
  return !(component.holes || []).some((hole) => pointInPolygon(point, hole)
    && !pointOnPolygonBoundary(point, hole, tolerance));
}

function componentEffectiveArea(component) {
  return Math.max(0, absolutePolygonArea(component.polygon)
    - (component.holes || []).reduce((sum, hole) => sum + absolutePolygonArea(hole), 0));
}

function bboxContains(outer, inner, tolerance = 0.5) {
  return inner.minX >= outer.minX - tolerance
    && inner.minY >= outer.minY - tolerance
    && inner.maxX <= outer.maxX + tolerance
    && inner.maxY <= outer.maxY + tolerance;
}

function componentContainedBy(inner, outer, tolerance = 0.5) {
  const innerBox = inner.bbox || bboxOfPoints(inner.polygon);
  const outerBox = outer.bbox || bboxOfPoints(outer.polygon);
  if (!bboxContains(outerBox, innerBox, tolerance)) return false;
  const samples = [];
  for (let index = 0; index < inner.polygon.length; index += 1) {
    const current = inner.polygon[index];
    const next = inner.polygon[(index + 1) % inner.polygon.length];
    samples.push(current, { x: (current.x + next.x) / 2, y: (current.y + next.y) / 2 });
  }
  return samples.every((point) => pointInComponent(point, outer, tolerance));
}

/**
 * HATCH is interpreted as a filled-area union. A component completely covered
 * by another component must not become a second selectable/tiled region,
 * otherwise grouped layout draws the same physical tile twice.
 */
export function dedupeContainedHatchComponents(components, tolerance = 0.5) {
  const prepared = (components || []).map((component, sourceIndex) => ({
    ...component,
    sourceIndex,
    bbox: bboxOfPoints(component.polygon || []),
    effectiveArea: componentEffectiveArea(component)
  })).sort((a, b) => b.effectiveArea - a.effectiveArea || b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height);

  const kept = [];
  const removed = [];
  for (const candidate of prepared) {
    const covering = kept.find((outer) => outer.effectiveArea >= candidate.effectiveArea - 1
      && componentContainedBy(candidate, outer, tolerance));
    if (covering) {
      removed.push({ component: candidate, coveredBy: covering });
      continue;
    }
    kept.push(candidate);
  }
  const clean = (component) => {
    const { bbox, effectiveArea, sourceIndex, ...rest } = component;
    return rest;
  };
  return {
    components: kept.map(clean),
    removed: removed.map(({ component, coveredBy }) => ({ component: clean(component), coveredBy: clean(coveredBy) })),
    removedCount: removed.length
  };
}

export function hatchComponentsFromLayer(cad, layerName, options = {}) {
  const hatches = hatchEntitiesOnLayer(cad, layerName);
  const rawComponents = hatches.flatMap((entity) => extractHatchComponents(entity, options));
  const deduped = options.dedupeContained === false
    ? { components: rawComponents, removed: [], removedCount: 0 }
    : dedupeContainedHatchComponents(rawComponents, Number(options.containmentTolerance ?? 0.5));
  return {
    hatches,
    rawComponents,
    components: deduped.components,
    removedContained: deduped.removed,
    removedContainedCount: deduped.removedCount,
    holeCount: deduped.components.reduce((sum, component) => sum + (component.holes?.length || 0), 0)
  };
}
