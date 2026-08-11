import {
  absolutePolygonArea,
  bboxOfPoints,
  bboxesIntersect,
  cleanPolygon,
  clipPolygonToRect,
  isAxisAlignedRectangle,
  overlap1D,
  pointInPolygon,
  signedPolygonArea,
  simplifyCollinear
} from './geometry.js';
import {
  cellsForRegion,
  intersectRegionCellsWithRect,
  orthogonalizePolygon
} from './orthogonal-geometry.js';

const MAX_CANDIDATE_CELLS = 220000;

function relevantBandForRegion(band, axis, target, group) {
  if (band.enabled === false || band.axis !== axis) return false;
  if (!band.global && band.groupId && band.groupId !== group.id) return false;
  if (band.global) return true;
  const bbox = target?.bbox || target;
  if (axis === 'x') {
    const overlap = overlap1D(Number(band.minY), Number(band.maxY), bbox.minY, bbox.maxY);
    return overlap > Math.min(50, Math.max(1, bbox.height * 0.01));
  }
  const overlap = overlap1D(Number(band.minX), Number(band.maxX), bbox.minX, bbox.maxX);
  return overlap > Math.min(50, Math.max(1, bbox.width * 0.01));
}

export function buildAxisMap(bands, axis, target, group = { id: '' }) {
  const intervals = [];
  for (const band of bands || []) {
    if (!relevantBandForRegion(band, axis, target, group)) continue;
    const start = axis === 'x' ? Number(band.minX) : Number(band.minY);
    const end = axis === 'x' ? Number(band.maxX) : Number(band.maxY);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.01) continue;
    intervals.push({ start, end, sourceIds: [band.id], types: [band.type || '分界'] });
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + 0.5) {
      last.end = Math.max(last.end, interval.end);
      last.sourceIds.push(...interval.sourceIds);
      last.types.push(...interval.types);
    } else {
      merged.push({ ...interval });
    }
  }
  let removed = 0;
  for (const interval of merged) {
    interval.width = interval.end - interval.start;
    interval.compressed = interval.start - removed;
    removed += interval.width;
  }
  return merged;
}

export function compressCoordinate(value, axisMap) {
  let compressed = Number(value);
  for (const interval of axisMap) {
    if (value >= interval.end) compressed -= interval.width;
    else if (value > interval.start) {
      compressed -= value - interval.start;
      break;
    } else break;
  }
  return compressed;
}

function shiftAt(value, axisMap, includeAtValue) {
  let shift = 0;
  for (const interval of axisMap) {
    if (interval.compressed < value || (includeAtValue && Math.abs(interval.compressed - value) < 1e-7)) {
      shift += interval.width;
    } else break;
  }
  return shift;
}

export function expandCompressedInterval(start, end, axisMap) {
  if (end <= start) return [];
  if (!axisMap.length) return [{ min: start, max: end, compressedMin: start, compressedMax: end }];
  const cuts = axisMap
    .map((interval) => interval.compressed)
    .filter((value) => value > start + 1e-7 && value < end - 1e-7);
  const boundaries = [start, ...cuts, end];
  const parts = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const a = boundaries[index];
    const b = boundaries[index + 1];
    const startsAtCut = index > 0 || axisMap.some((interval) => Math.abs(interval.compressed - a) < 1e-7);
    const physicalStart = a + shiftAt(a, axisMap, startsAtCut);
    const physicalEnd = b + shiftAt(b, axisMap, false);
    if (physicalEnd - physicalStart > 1e-6) {
      parts.push({ min: physicalStart, max: physicalEnd, compressedMin: a, compressedMax: b });
    }
  }
  return parts;
}

function getGroupForRegion(region, groupsById) {
  return groupsById.get(region.groupId) || {
    id: region.groupId || region.id,
    name: region.name,
    unifiedOrigin: false,
    carryAcross: false,
    originX: region.originX,
    originY: region.originY,
    left: 0,
    right: 0,
    up: 0,
    down: 0,
    offsetX: 0,
    offsetY: 0,
    originAlignX: 0,
    originAlignY: 0,
    staggerPhaseX: 0,
    staggerPhaseY: 0
  };
}

export function effectiveOrigin(region, group) {
  const unified = group.unifiedOrigin !== false;
  const baseX = unified ? Number(group.originX) : Number(region.originX);
  const baseY = unified ? Number(group.originY) : Number(region.originY);
  const control = unified ? group : region;
  const originX = (Number.isFinite(baseX) ? baseX : region.bbox.minX)
    + Number(control.offsetX || 0)
    + Number(control.right || 0)
    - Number(control.left || 0);
  const originY = (Number.isFinite(baseY) ? baseY : region.bbox.minY)
    + Number(control.offsetY || 0)
    + Number(control.up || 0)
    - Number(control.down || 0);
  return { x: originX, y: originY };
}

function cellRange(min, max, origin, pitch) {
  if (!Number.isFinite(pitch) || pitch <= 0) return [0, -1];
  return [Math.floor((min - origin) / pitch) - 1, Math.ceil((max - origin) / pitch) + 1];
}

function polygonCoordinateString(points) {
  return points.map((point) => `${point.x.toFixed(3)} ${point.y.toFixed(3)}`).join(';');
}

export function normalizeRotation(value) {
  const normalized = ((Number(value || 0) % 180) + 180) % 180;
  return normalized >= 45 && normalized < 135 ? 90 : 0;
}

export function nominalTileSize(settings, rotation) {
  const longSide = Math.max(1, Number(settings.tileLong || settings.tileWidth || 300));
  const shortSide = Math.max(1, Number(settings.tileShort || settings.tileHeight || 300));
  return normalizeRotation(rotation) === 90
    ? { width: shortSide, height: longSide, longAxis: 'Y', rotation: 90 }
    : { width: longSide, height: shortSide, longAxis: 'X', rotation: 0 };
}


function implicitGapKey(band) {
  return [band.groupId, band.axis,
    Math.round(band.minX * 10), Math.round(band.maxX * 10),
    Math.round(band.minY * 10), Math.round(band.maxY * 10)].join(':');
}

export function deriveImplicitGapBands(regions, groups = []) {
  const groupsById = new Map((groups || []).map((group) => [group.id, group]));
  const membersByGroup = new Map();
  for (const region of regions || []) {
    if (region.enabled === false || !region.bbox) continue;
    const list = membersByGroup.get(region.groupId) || [];
    list.push(region);
    membersByGroup.set(region.groupId, list);
  }
  const output = [];
  const seen = new Set();
  for (const [groupId, members] of membersByGroup) {
    const group = groupsById.get(groupId);
    if (!group || group.unifiedOrigin === false || group.carryAcross === false || members.length < 2) continue;
    for (const region of members) {
      const a = region.bbox;
      const rightCandidates = members
        .filter((other) => other !== region && other.bbox.minX >= a.maxX - 0.05)
        .map((other) => ({ other, gap: other.bbox.minX - a.maxX, overlap: overlap1D(a.minY, a.maxY, other.bbox.minY, other.bbox.maxY) }))
        .filter((item) => item.gap > 0.05 && item.overlap > 1);
      if (rightCandidates.length) {
        const nearest = Math.min(...rightCandidates.map((item) => item.gap));
        for (const item of rightCandidates.filter((candidate) => candidate.gap <= nearest + 0.5)) {
          const band = {
            id: `implicit-${groupId}-x-${region.id}-${item.other.id}`,
            type: '跨區空隙', axis: 'x', groupId, global: false, enabled: true, implicit: true,
            minX: a.maxX, maxX: item.other.bbox.minX,
            minY: Math.max(a.minY, item.other.bbox.minY),
            maxY: Math.min(a.maxY, item.other.bbox.maxY)
          };
          const key = implicitGapKey(band);
          if (!seen.has(key)) { seen.add(key); output.push(band); }
        }
      }

      const upperCandidates = members
        .filter((other) => other !== region && other.bbox.minY >= a.maxY - 0.05)
        .map((other) => ({ other, gap: other.bbox.minY - a.maxY, overlap: overlap1D(a.minX, a.maxX, other.bbox.minX, other.bbox.maxX) }))
        .filter((item) => item.gap > 0.05 && item.overlap > 1);
      if (upperCandidates.length) {
        const nearest = Math.min(...upperCandidates.map((item) => item.gap));
        for (const item of upperCandidates.filter((candidate) => candidate.gap <= nearest + 0.5)) {
          const band = {
            id: `implicit-${groupId}-y-${region.id}-${item.other.id}`,
            type: '跨區空隙', axis: 'y', groupId, global: false, enabled: true, implicit: true,
            minY: a.maxY, maxY: item.other.bbox.minY,
            minX: Math.max(a.minX, item.other.bbox.minX),
            maxX: Math.min(a.maxX, item.other.bbox.maxX)
          };
          const key = implicitGapKey(band);
          if (!seen.has(key)) { seen.add(key); output.push(band); }
        }
      }
    }
  }
  return output;
}

function subtractRect(source, cut) {
  const minX = Math.max(source.minX, cut.minX);
  const maxX = Math.min(source.maxX, cut.maxX);
  const minY = Math.max(source.minY, cut.minY);
  const maxY = Math.min(source.maxY, cut.maxY);
  if (maxX - minX <= 1e-7 || maxY - minY <= 1e-7) return [source];
  const output = [];
  const add = (a, b, c, d) => {
    if (c - a > 1e-7 && d - b > 1e-7) output.push({ minX: a, minY: b, maxX: c, maxY: d, width: c - a, height: d - b });
  };
  add(source.minX, source.minY, minX, source.maxY);
  add(maxX, source.minY, source.maxX, source.maxY);
  add(minX, source.minY, maxX, minY);
  add(minX, maxY, maxX, source.maxY);
  return output;
}

function rectFragmentsOutsideHoles(rect, region, warnings, warnedRegions) {
  let fragments = [rect];
  for (const hole of region.holes || []) {
    if (!hole?.length) continue;
    const holeBox = bboxOfPoints(hole);
    if (!bboxesIntersect(rect, holeBox, 0.01)) continue;
    if (!isAxisAlignedRectangle(hole, 0.25) && !warnedRegions.has(region.id)) {
      warnings.push(`${region.name} 有非矩形 HATCH 孔洞；目前以孔洞外接矩形保守扣除，施工前需核對。`);
      warnedRegions.add(region.id);
    }
    fragments = fragments.flatMap((fragment) => subtractRect(fragment, holeBox));
    if (!fragments.length) break;
  }
  return fragments;
}

function positiveParity(value) {
  return ((value % 2) + 2) % 2;
}

// A short edge at a concave recess is not itself a narrow projecting tile
// piece. Only an edge whose two endpoints are convex corners contributes to
// the small-cut warning; this keeps shallow notches from being marked red.
function polygonMinProtrudingEdge(points = []) {
  if (points.length < 3) return Infinity;
  const orientation = signedPolygonArea(points) >= 0 ? 1 : -1;
  const convex = points.map((current, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const cross = (current.x - previous.x) * (next.y - current.y)
      - (current.y - previous.y) * (next.x - current.x);
    return cross * orientation >= -1e-7;
  });
  let result = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    if (!convex[index] || !convex[next]) continue;
    const length = Math.hypot(points[next].x - points[index].x, points[next].y - points[index].y);
    if (length > 0.25) result = Math.min(result, length);
  }
  return result;
}

function mergeBBoxInto(target, bbox) {
  target.minX = Math.min(target.minX, bbox.minX);
  target.minY = Math.min(target.minY, bbox.minY);
  target.maxX = Math.max(target.maxX, bbox.maxX);
  target.maxY = Math.max(target.maxY, bbox.maxY);
  target.width = target.maxX - target.minX;
  target.height = target.maxY - target.minY;
}

function pointInsideRegion(point, region) {
  if (!pointInPolygon(point, region.polygon || [])) return false;
  return !(region.holes || []).some((hole) => pointInPolygon(point, hole));
}

function regionBoundarySegments(region) {
  const polygon = orthogonalizePolygon(region.polygon || [], 2);
  const bbox = region.bbox || bboxOfPoints(polygon);
  const epsilon = Math.max(0.05, Math.min(Math.max(1, bbox.width), Math.max(1, bbox.height)) * 1e-6);
  const output = { left: [], right: [], top: [], bottom: [] };
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (Math.abs(dx) <= 2 && Math.abs(dy) > 0.1) {
      const x = (a.x + b.x) / 2;
      const min = Math.min(a.y, b.y);
      const max = Math.max(a.y, b.y);
      const leftInside = pointInsideRegion({ x: x - epsilon, y: midpoint.y }, region);
      const rightInside = pointInsideRegion({ x: x + epsilon, y: midpoint.y }, region);
      if (leftInside && !rightInside) output.right.push({ coordinate: x, min, max });
      else if (rightInside && !leftInside) output.left.push({ coordinate: x, min, max });
    } else if (Math.abs(dy) <= 2 && Math.abs(dx) > 0.1) {
      const y = (a.y + b.y) / 2;
      const min = Math.min(a.x, b.x);
      const max = Math.max(a.x, b.x);
      const belowInside = pointInsideRegion({ x: midpoint.x, y: y - epsilon }, region);
      const aboveInside = pointInsideRegion({ x: midpoint.x, y: y + epsilon }, region);
      if (belowInside && !aboveInside) output.top.push({ coordinate: y, min, max });
      else if (aboveInside && !belowInside) output.bottom.push({ coordinate: y, min, max });
    }
  }
  return output;
}

function overlapLength(a, b) {
  return Math.max(0, Math.min(a.max, b.max) - Math.max(a.min, b.min));
}

function bestFacingEdgePair(regionA, segmentsA, regionB, segmentsB) {
  const candidates = [];
  const addHorizontal = (rightRegion, rightEdges, leftRegion, leftEdges, aIsRight) => {
    for (const right of rightEdges) {
      for (const left of leftEdges) {
        const gap = left.coordinate - right.coordinate;
        if (gap < -0.5) continue;
        const overlap = overlapLength(right, left);
        if (overlap <= 1) continue;
        const delta = aIsRight ? { x: Math.max(0, gap), y: 0 } : { x: -Math.max(0, gap), y: 0 };
        candidates.push({
          axis: 'x', gap: Math.max(0, gap), overlap,
          delta, weight: Math.max(0, gap) + 20 / Math.max(1, overlap),
          from: regionA.id, to: regionB.id,
          physicalBand: {
            axis: 'x', minX: right.coordinate, maxX: left.coordinate,
            minY: Math.max(right.min, left.min), maxY: Math.min(right.max, left.max)
          }
        });
      }
    }
  };
  const addVertical = (bottomRegion, topEdges, topRegion, bottomEdges, aIsBottom) => {
    for (const top of topEdges) {
      for (const bottom of bottomEdges) {
        const gap = bottom.coordinate - top.coordinate;
        if (gap < -0.5) continue;
        const overlap = overlapLength(top, bottom);
        if (overlap <= 1) continue;
        const delta = aIsBottom ? { x: 0, y: Math.max(0, gap) } : { x: 0, y: -Math.max(0, gap) };
        candidates.push({
          axis: 'y', gap: Math.max(0, gap), overlap,
          delta, weight: Math.max(0, gap) + 20 / Math.max(1, overlap),
          from: regionA.id, to: regionB.id,
          physicalBand: {
            axis: 'y', minY: top.coordinate, maxY: bottom.coordinate,
            minX: Math.max(top.min, bottom.min), maxX: Math.min(top.max, bottom.max)
          }
        });
      }
    }
  };

  // A on the left of B.
  addHorizontal(regionA, segmentsA.right, regionB, segmentsB.left, true);
  // B on the left of A; delta from A to B is negative.
  addHorizontal(regionB, segmentsB.right, regionA, segmentsA.left, false);
  // A below B.
  addVertical(regionA, segmentsA.top, regionB, segmentsB.bottom, true);
  // B below A; delta from A to B is negative.
  addVertical(regionB, segmentsB.top, regionA, segmentsA.bottom, false);

  candidates.sort((a, b) => a.weight - b.weight || b.overlap - a.overlap);
  return candidates[0] || null;
}

class DisjointSet {
  constructor(items) {
    this.parent = new Map(items.map((item) => [item, item]));
  }
  find(item) {
    const parent = this.parent.get(item);
    if (parent === item) return item;
    const root = this.find(parent);
    this.parent.set(item, root);
    return root;
  }
  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return false;
    this.parent.set(rootB, rootA);
    return true;
  }
}

function distanceToBBox(point, bbox) {
  const dx = point.x < bbox.minX ? bbox.minX - point.x : point.x > bbox.maxX ? point.x - bbox.maxX : 0;
  const dy = point.y < bbox.minY ? bbox.minY - point.y : point.y > bbox.maxY ? point.y - bbox.maxY : 0;
  return Math.hypot(dx, dy);
}

function chooseAnchorRegion(members, group) {
  const explicit = members.find((region) => region.id === group.anchorRegionId);
  if (explicit) return explicit;
  const origin = { x: Number(group.originX), y: Number(group.originY) };
  if (Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
    const containing = members.find((region) => pointInsideRegion(origin, region));
    if (containing) return containing;
    return [...members].sort((a, b) => distanceToBBox(origin, a.bbox) - distanceToBBox(origin, b.bbox))[0];
  }
  return [...members].sort((a, b) => a.bbox.minX - b.bbox.minX || a.bbox.minY - b.bbox.minY)[0];
}

/**
 * Builds per-region virtual translations. A 20/225/325 mm physical gap becomes
 * zero width in virtual coordinates, but no visible black rectangle is created.
 * This makes grouped regions keep one origin and one brick-bond phase until the
 * group is explicitly split.
 */
export function buildGroupVirtualTransforms(regions, groups = []) {
  const groupsById = new Map((groups || []).map((group) => [group.id, group]));
  const membersByGroup = new Map();
  for (const region of regions || []) {
    if (region.enabled === false || !region.polygon?.length) continue;
    region.bbox = region.bbox || bboxOfPoints(region.polygon);
    const list = membersByGroup.get(region.groupId) || [];
    list.push(region);
    membersByGroup.set(region.groupId, list);
  }

  const transforms = new Map();
  const groupInfo = new Map();
  const virtualGaps = [];
  const warnings = [];

  for (const [groupId, members] of membersByGroup) {
    const group = groupsById.get(groupId) || getGroupForRegion(members[0], groupsById);
    if (group.unifiedOrigin === false || group.carryAcross === false || members.length < 2) {
      for (const region of members) transforms.set(region.id, { shiftX: 0, shiftY: 0, component: region.id });
      const anchor = members[0];
      groupInfo.set(groupId, { anchorRegionId: anchor?.id, anchor, edges: [], connected: members.length <= 1 });
      continue;
    }

    const segments = new Map(members.map((region) => [region.id, regionBoundarySegments(region)]));
    const candidates = [];
    for (let aIndex = 0; aIndex < members.length; aIndex += 1) {
      for (let bIndex = aIndex + 1; bIndex < members.length; bIndex += 1) {
        const a = members[aIndex]; const b = members[bIndex];
        const candidate = bestFacingEdgePair(a, segments.get(a.id), b, segments.get(b.id));
        if (candidate) candidates.push(candidate);
      }
    }
    candidates.sort((a, b) => a.weight - b.weight || b.overlap - a.overlap);
    const set = new DisjointSet(members.map((region) => region.id));
    const edges = [];
    for (const candidate of candidates) {
      if (!set.union(candidate.from, candidate.to)) continue;
      edges.push(candidate);
      if (edges.length === members.length - 1) break;
    }

    const anchor = chooseAnchorRegion(members, group);
    const adjacency = new Map(members.map((region) => [region.id, []]));
    for (const edge of edges) {
      adjacency.get(edge.from).push({ to: edge.to, delta: edge.delta, edge });
      adjacency.get(edge.to).push({ to: edge.from, delta: { x: -edge.delta.x, y: -edge.delta.y }, edge });
      virtualGaps.push({
        id: `virtual-${groupId}-${edge.from}-${edge.to}`,
        type: '跨區虛擬空隙', groupId, axis: edge.axis,
        gap: edge.gap, overlap: edge.overlap,
        visible: false, implicit: true, enabled: true,
        ...edge.physicalBand
      });
    }

    const queue = [anchor.id];
    transforms.set(anchor.id, { shiftX: 0, shiftY: 0, component: anchor.id });
    while (queue.length) {
      const currentId = queue.shift();
      const current = transforms.get(currentId);
      for (const link of adjacency.get(currentId) || []) {
        if (transforms.has(link.to)) continue;
        transforms.set(link.to, {
          shiftX: current.shiftX + link.delta.x,
          shiftY: current.shiftY + link.delta.y,
          component: anchor.id
        });
        queue.push(link.to);
      }
    }

    const disconnected = members.filter((region) => !transforms.has(region.id));
    for (const region of disconnected) transforms.set(region.id, { shiftX: 0, shiftY: 0, component: region.id });
    if (disconnected.length) warnings.push(`${group.name || group.id} 有 ${disconnected.length} 個區域無法由相向邊建立連續關係；這些區域暫以原坐標排布。`);
    groupInfo.set(groupId, { anchorRegionId: anchor.id, anchor, edges, connected: disconnected.length === 0 });
  }
  return { transforms, groupInfo, virtualGaps, warnings };
}

function rectPolygon(rect) {
  return [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY }
  ];
}

function polygonSignature(points = [], precision = 100) {
  const normalized = points.map((point) => `${Math.round(point.x * precision)},${Math.round(point.y * precision)}`);
  if (!normalized.length) return '';
  let best = null;
  for (let reverse = 0; reverse < 2; reverse += 1) {
    const source = reverse ? [...normalized].reverse() : normalized;
    for (let offset = 0; offset < source.length; offset += 1) {
      const value = [...source.slice(offset), ...source.slice(0, offset)].join('|');
      if (best == null || value < best) best = value;
    }
  }
  return best;
}

function intersectionsForTile(region, prepared, rect, warnings, warnedRegions) {
  const orthogonal = intersectRegionCellsWithRect(prepared, rect);
  if (orthogonal) {
    const output = [];
    for (const item of orthogonal) {
      if (item.holes?.length) {
        // A tile with an internal void must be physically split. Retain exact
        // occupied rectangles rather than drawing a filled polygon over the hole.
        for (const cell of prepared.cells || []) {
          const minX = Math.max(cell.minX, rect.minX);
          const maxX = Math.min(cell.maxX, rect.maxX);
          const minY = Math.max(cell.minY, rect.minY);
          const maxY = Math.min(cell.maxY, rect.maxY);
          if (maxX - minX > 1e-7 && maxY - minY > 1e-7) output.push({ polygon: rectPolygon({ minX, minY, maxX, maxY }), voidSplit: true });
        }
      } else output.push({ polygon: item.polygon, voidSplit: false });
    }
    return output;
  }

  // Fallback for genuinely non-orthogonal boundaries.
  const subRects = rectFragmentsOutsideHoles(rect, region, warnings, warnedRegions);
  return subRects.map((subRect) => ({ polygon: simplifyCollinear(clipPolygonToRect(region.polygon, subRect), 0.02), voidSplit: subRects.length > 1 }));
}

export function generateLayout(model) {
  const settings = model.settings || {};
  const jointX = Math.max(0, Number(settings.jointX || 0));
  const jointY = Math.max(0, Number(settings.jointY || 0));
  const minCut = Math.max(0, Number(settings.minCut || 0));
  const groupsById = new Map((model.groups || []).map((group) => [group.id, group]));
  const enabledRegions = (model.regions || []).filter((region) => region.enabled !== false && region.polygon?.length);
  for (const region of enabledRegions) region.bbox = region.bbox || bboxOfPoints(region.polygon);

  const virtual = buildGroupVirtualTransforms(enabledRegions, model.groups || []);
  const pieces = [];
  const tiles = new Map();
  const warnings = [...virtual.warnings];
  const warnedHoleRegions = new Set();
  const preparedRegions = new Map(enabledRegions.map((region) => [region.id, cellsForRegion(region)]));
  let candidateCells = 0;
  let stopped = false;

  for (const region of enabledRegions) {
    if (stopped) break;
    const sourceGroup = getGroupForRegion(region, groupsById);
    const unified = sourceGroup.unifiedOrigin !== false;
    const groupInfo = virtual.groupInfo.get(sourceGroup.id);
    const anchorRegion = unified ? (groupInfo?.anchor || region) : region;
    const group = unified ? sourceGroup : { ...sourceGroup, id: region.id, name: region.name, unifiedOrigin: false, carryAcross: false };
    const transform = virtual.transforms.get(region.id) || { shiftX: 0, shiftY: 0 };
    const anchorTransform = virtual.transforms.get(anchorRegion.id) || { shiftX: 0, shiftY: 0 };
    const originPhysical = effectiveOrigin(anchorRegion, sourceGroup);
    const originU = originPhysical.x
      + (Number(sourceGroup.originAlignX || 0) < 0 ? jointX : 0)
      - anchorTransform.shiftX;
    const originV = originPhysical.y
      + (Number(sourceGroup.originAlignY || 0) < 0 ? jointY : 0)
      - anchorTransform.shiftY;
    const tileSize = nominalTileSize(settings, region.rotation);
    const pitchX = tileSize.width + jointX;
    const pitchY = tileSize.height + jointY;
    const staggerEnabled = settings.staggerEnabled !== false;
    const staggerDistance = staggerEnabled ? Math.max(0, Number(settings.staggerOffset || tileSize.width / 2)) : 0;

    const uMin = region.bbox.minX - transform.shiftX;
    const uMax = region.bbox.maxX - transform.shiftX;
    const vMin = region.bbox.minY - transform.shiftY;
    const vMax = region.bbox.maxY - transform.shiftY;
    const [iStart, iEnd] = cellRange(uMin - staggerDistance, uMax + staggerDistance, originU, pitchX);
    const [jStart, jEnd] = cellRange(vMin - staggerDistance, vMax + staggerDistance, originV, pitchY);
    const count = Math.max(0, iEnd - iStart + 1) * Math.max(0, jEnd - jStart + 1);
    candidateCells += count;
    if (candidateCells > MAX_CANDIDATE_CELLS) {
      warnings.push(`候選磚格超過 ${MAX_CANDIDATE_CELLS.toLocaleString()}；已停止計算，請增大磚尺寸或暫時關閉部分區域。`);
      stopped = true;
      break;
    }

    for (let i = iStart; i <= iEnd; i += 1) {
      for (let j = jStart; j <= jEnd; j += 1) {
        const xStagger = tileSize.longAxis === 'X'
          ? positiveParity(j + Number(sourceGroup.staggerPhaseY || 0)) * staggerDistance : 0;
        const yStagger = tileSize.longAxis === 'Y'
          ? positiveParity(i + Number(sourceGroup.staggerPhaseX || 0)) * staggerDistance : 0;
        const u0 = originU + i * pitchX + xStagger;
        const u1 = u0 + tileSize.width;
        if (u1 < uMin - 1e-6 || u0 > uMax + 1e-6) continue;
        const v0 = originV + j * pitchY + yStagger;
        const v1 = v0 + tileSize.height;
        if (v1 < vMin - 1e-6 || v0 > vMax + 1e-6) continue;
        const physicalRect = {
          minX: u0 + transform.shiftX,
          maxX: u1 + transform.shiftX,
          minY: v0 + transform.shiftY,
          maxY: v1 + transform.shiftY,
          width: tileSize.width,
          height: tileSize.height
        };
        if (!bboxesIntersect(physicalRect, region.bbox, 0.01)) continue;
        const tileId = `${group.id}:${tileSize.rotation}:${i}:${j}`;
        const intersections = intersectionsForTile(region, preparedRegions.get(region.id), physicalRect, warnings, warnedHoleRegions);
        for (const intersection of intersections) {
          const clipped = simplifyCollinear(cleanPolygon(intersection.polygon), 0.02);
          if (clipped.length < 3) continue;
          const area = absolutePolygonArea(clipped);
          if (area < 0.5) continue;
          const pieceBox = bboxOfPoints(clipped);
          const rectangular = isAxisAlignedRectangle(clipped, 0.2);
          const minEdge = polygonMinProtrudingEdge(clipped);
          const piece = {
            id: `${region.id}:${i}:${j}:${pieces.length}`,
            tileId,
            regionId: region.id,
            regionName: region.name,
            groupId: group.id,
            groupName: group.name,
            rotation: tileSize.rotation,
            longAxis: tileSize.longAxis,
            nominalWidth: tileSize.width,
            nominalHeight: tileSize.height,
            i, j,
            fragmentIndex: 0,
            polygon: clipped,
            bbox: pieceBox,
            width: pieceBox.width,
            height: pieceBox.height,
            area,
            rectArea: physicalRect.width * physicalRect.height,
            rectangular,
            fillsFragment: rectangular && Math.abs(area - tileSize.width * tileSize.height) <= Math.max(1, tileSize.width * tileSize.height * 0.0015),
            continuation: false,
            voidSplit: Boolean(intersection.voidSplit),
            minEdge,
            minimumDimension: Math.min(pieceBox.width, pieceBox.height, minEdge),
            sourceApproximate: Boolean(region.approximate),
            coordinates: polygonCoordinateString(clipped),
            virtualShiftX: transform.shiftX,
            virtualShiftY: transform.shiftY
          };
          pieces.push(piece);
          const tile = tiles.get(tileId) || {
            id: tileId,
            pieces: [],
            nominalArea: tileSize.width * tileSize.height,
            nominalWidth: tileSize.width,
            nominalHeight: tileSize.height,
            longAxis: tileSize.longAxis,
            regionIds: new Set(),
            continuation: false,
            voidSplit: false
          };
          tile.pieces.push(piece);
          tile.regionIds.add(region.id);
          tile.voidSplit ||= piece.voidSplit;
          tiles.set(tileId, tile);
        }
      }
    }
  }

  // Remove duplicate physical pieces caused by overlapping source HATCHes or a
  // legacy saved project. The same tile/polygon may only be emitted once.
  for (const tile of tiles.values()) {
    const seen = new Set();
    tile.pieces = tile.pieces.filter((piece) => {
      const signature = polygonSignature(piece.polygon);
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
    tile.regionIds = new Set(tile.pieces.map((piece) => piece.regionId));
    tile.continuation = tile.regionIds.size > 1;
    tile.pieces.sort((a, b) => a.bbox.minY - b.bbox.minY || a.bbox.minX - b.bbox.minX);
    tile.pieces.forEach((piece, index) => {
      piece.fragmentIndex = index;
      piece.continuation = tile.continuation;
    });
  }

  const retainedPieces = [...tiles.values()].flatMap((tile) => tile.pieces);
  let fullTiles = 0;
  let cutTiles = 0;
  let cutPieces = 0;
  let continuationTiles = 0;
  let minPiece = Infinity;
  let smallCutPieces = 0;
  for (const tile of tiles.values()) {
    const totalArea = tile.pieces.reduce((sum, piece) => sum + piece.area, 0);
    const full = tile.pieces.length === 1
      && tile.pieces[0].fillsFragment
      && !tile.continuation
      && !tile.voidSplit
      && Math.abs(totalArea - tile.nominalArea) <= Math.max(1, tile.nominalArea * 0.002);
    tile.full = full;
    if (full) fullTiles += 1;
    else {
      cutTiles += 1;
      if (tile.continuation) continuationTiles += 1;
      for (const piece of tile.pieces) {
        piece.cut = true;
        cutPieces += 1;
        const minimumDimension = Math.min(piece.width, piece.height, piece.minEdge ?? Infinity);
        piece.minimumDimension = minimumDimension;
        minPiece = Math.min(minPiece, minimumDimension);
        piece.smallCut = minimumDimension < minCut - 0.01;
        if (piece.smallCut) smallCutPieces += 1;
      }
    }
  }
  for (const piece of retainedPieces) piece.cut = !tiles.get(piece.tileId)?.full;

  if (smallCutPieces) warnings.push(`${smallCutPieces} 塊非整磚的最小尺寸或邊長低於 ${minCut} mm。`);
  if (retainedPieces.some((piece) => piece.sourceApproximate)) warnings.push('目前有區域仍使用 QA 外框預覽；請完成 DXF 精確解析後再作施工尺寸。');
  return {
    pieces: retainedPieces,
    tiles,
    warnings,
    implicitBands: [],
    virtualGaps: virtual.virtualGaps,
    groupTransforms: virtual.transforms,
    stats: {
      candidateCells,
      conceptualTiles: tiles.size,
      fullTiles,
      cutTiles,
      cutPieces,
      continuationTiles,
      smallCutPieces,
      minPiece: Number.isFinite(minPiece) ? minPiece : null
    }
  };
}

export function deriveStandardGapBands(regions, standards = [20, 225, 325, 265, 365], tolerance = 3) {
  const candidates = [];
  const enabled = (regions || []).filter((region) => region.enabled !== false && region.bbox);
  for (let aIndex = 0; aIndex < enabled.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < enabled.length; bIndex += 1) {
      const regionA = enabled[aIndex];
      const regionB = enabled[bIndex];
      if (regionA.groupId !== regionB.groupId) continue;
      const a = regionA.bbox;
      const b = regionB.bbox;
      const yOverlap = overlap1D(a.minY, a.maxY, b.minY, b.maxY);
      if (yOverlap > 100) {
        let minX;
        let maxX;
        if (a.maxX <= b.minX) { minX = a.maxX; maxX = b.minX; }
        else if (b.maxX <= a.minX) { minX = b.maxX; maxX = a.minX; }
        if (minX !== undefined) {
          const width = maxX - minX;
          const standard = standards.find((value) => Math.abs(value - width) <= tolerance);
          if (standard) candidates.push({
            axis: 'x', minX, maxX,
            minY: Math.max(a.minY, b.minY), maxY: Math.min(a.maxY, b.maxY),
            width, standard, groupId: regionA.groupId
          });
        }
      }
      const xOverlap = overlap1D(a.minX, a.maxX, b.minX, b.maxX);
      if (xOverlap > 100) {
        let minY;
        let maxY;
        if (a.maxY <= b.minY) { minY = a.maxY; maxY = b.minY; }
        else if (b.maxY <= a.minY) { minY = b.maxY; maxY = a.minY; }
        if (minY !== undefined) {
          const width = maxY - minY;
          const standard = standards.find((value) => Math.abs(value - width) <= tolerance);
          if (standard) candidates.push({
            axis: 'y', minY, maxY,
            minX: Math.max(a.minX, b.minX), maxX: Math.min(a.maxX, b.maxX),
            width, standard, groupId: regionA.groupId
          });
        }
      }
    }
  }
  return candidates;
}
