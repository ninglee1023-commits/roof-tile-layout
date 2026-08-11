import { bboxOfPoints, polygonCentroid, rectanglePolygon } from './geometry.js';

function safeText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E]/g, '?').slice(0, 240);
}

function pairs(values) {
  return values.join('\r\n') + '\r\n';
}

function lineEntity(layer, a, b, color = 256) {
  return pairs(['0', 'LINE', '8', layer, '62', String(color),
    '10', String(a.x), '20', String(a.y), '30', '0',
    '11', String(b.x), '21', String(b.y), '31', '0']);
}

function polylineEntity(layer, polygon, color = 256, closed = true) {
  if (!polygon?.length) return '';
  const out = ['0', 'POLYLINE', '8', layer, '62', String(color), '66', '1', '70', closed ? '1' : '0', '10', '0', '20', '0', '30', '0'];
  for (const point of polygon) out.push('0', 'VERTEX', '8', layer, '10', String(point.x), '20', String(point.y), '30', '0');
  out.push('0', 'SEQEND', '8', layer);
  return pairs(out);
}

function textEntity(layer, point, text, height = 100, color = 256) {
  return pairs(['0', 'TEXT', '8', layer, '62', String(color),
    '10', String(point.x), '20', String(point.y), '30', '0',
    '40', String(height), '1', safeText(text), '50', '0', '7', 'STANDARD',
    '72', '1', '73', '2', '11', String(point.x), '21', String(point.y), '31', '0']);
}

function uniqueSorted(values, tolerance = 0.01) {
  return values.sort((a, b) => a - b).filter((value, index, array) => index === 0 || Math.abs(value - array[index - 1]) > tolerance);
}

function interiorSpanAt(polygon, axis, coordinate) {
  if (!polygon?.length) return null;
  const intersections = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const aValue = axis === 'X' ? a.y : a.x;
    const bValue = axis === 'X' ? b.y : b.x;
    if ((aValue < coordinate && bValue < coordinate) || (aValue > coordinate && bValue > coordinate)) continue;
    if (Math.abs(aValue - bValue) < 1e-9) continue;
    const t = (coordinate - aValue) / (bValue - aValue);
    if (t < -1e-8 || t > 1 + 1e-8) continue;
    intersections.push(axis === 'X' ? a.x + (b.x - a.x) * t : a.y + (b.y - a.y) * t);
  }
  const values = uniqueSorted(intersections);
  if (values.length < 2) return null;
  const spans = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    if (values[index + 1] - values[index] > 1) spans.push({ start: values[index], end: values[index + 1] });
  }
  if (!spans.length) return null;
  return spans.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
}

function cutDimensionAxis(piece) {
  const nominalWidth = Number(piece.nominalWidth || 0);
  const nominalHeight = Number(piece.nominalHeight || 0);
  const widthDifference = Math.abs(Number(piece.width || 0) - nominalWidth);
  const heightDifference = Math.abs(Number(piece.height || 0) - nominalHeight);
  if (Math.max(widthDifference, heightDifference) <= 0.5) return null;
  return widthDifference >= heightDifference ? 'X' : 'Y';
}

function dimensionLineEntities(piece, axis, value, digits = 0) {
  const center = polygonCentroid(piece.polygon);
  const span = interiorSpanAt(piece.polygon, axis, axis === 'X' ? center.y : center.x);
  if (!span) return [];
  const length = span.end - span.start;
  const shortSide = Math.min(Number(piece.width || 0), Number(piece.height || 0));
  const inset = Math.min(length * 0.18, Math.max(4, shortSide * 0.08));
  const start = span.start + inset;
  const end = span.end - inset;
  if (end - start < 4) return [];
  const coordinate = axis === 'X' ? center.y : center.x;
  const arrow = Math.min(Math.max(4, shortSide * 0.05), (end - start) * 0.2);
  const textHeight = Math.max(5, Math.min(28, shortSide * 0.11));
  const entities = [];
  const a = axis === 'X' ? { x: start, y: coordinate } : { x: coordinate, y: start };
  const b = axis === 'X' ? { x: end, y: coordinate } : { x: coordinate, y: end };
  entities.push(lineEntity('RT_DIM', a, b, 1));
  if (axis === 'X') {
    entities.push(lineEntity('RT_DIM', a, { x: start + arrow, y: coordinate + arrow * 0.55 }, 1));
    entities.push(lineEntity('RT_DIM', a, { x: start + arrow, y: coordinate - arrow * 0.55 }, 1));
    entities.push(lineEntity('RT_DIM', b, { x: end - arrow, y: coordinate + arrow * 0.55 }, 1));
    entities.push(lineEntity('RT_DIM', b, { x: end - arrow, y: coordinate - arrow * 0.55 }, 1));
    entities.push(textEntity('RT_DIM', { x: (start + end) / 2, y: coordinate }, Number(value).toFixed(digits), textHeight, 1));
  } else {
    entities.push(lineEntity('RT_DIM', a, { x: coordinate + arrow * 0.55, y: start + arrow }, 1));
    entities.push(lineEntity('RT_DIM', a, { x: coordinate - arrow * 0.55, y: start + arrow }, 1));
    entities.push(lineEntity('RT_DIM', b, { x: coordinate + arrow * 0.55, y: end - arrow }, 1));
    entities.push(lineEntity('RT_DIM', b, { x: coordinate - arrow * 0.55, y: end - arrow }, 1));
    entities.push(textEntity('RT_DIM', { x: coordinate, y: (start + end) / 2 }, Number(value).toFixed(digits), textHeight, 1));
  }
  return entities;
}

function dedupePoints(points, tolerance = 1e-5) {
  const output = [];
  for (const point of points) {
    if (!output.some((item) => Math.hypot(item.x - point.x, item.y - point.y) <= tolerance)) output.push(point);
  }
  return output;
}

/** Return 45-degree hatch segments clipped to a simple polygon. */
export function hatchSegmentsForPolygon(polygon, spacing = 90) {
  if (!polygon?.length) return [];
  const box = bboxOfPoints(polygon);
  const minimum = box.minY - box.maxX;
  const maximum = box.maxY - box.minX;
  const start = Math.floor(minimum / spacing) * spacing;
  const segments = [];
  for (let constant = start; constant <= maximum + spacing; constant += spacing) {
    const intersections = [];
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index];
      const b = polygon[(index + 1) % polygon.length];
      const fa = a.y - a.x - constant;
      const fb = b.y - b.x - constant;
      if (Math.abs(fa) < 1e-9 && Math.abs(fb) < 1e-9) continue;
      if ((fa > 1e-9 && fb > 1e-9) || (fa < -1e-9 && fb < -1e-9)) continue;
      const denominator = fa - fb;
      if (Math.abs(denominator) < 1e-12) continue;
      const t = fa / denominator;
      if (t < -1e-9 || t > 1 + 1e-9) continue;
      intersections.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    const sorted = dedupePoints(intersections).sort((a, b) => (a.x + a.y) - (b.x + b.y));
    for (let index = 0; index + 1 < sorted.length; index += 2) {
      if (Math.hypot(sorted[index + 1].x - sorted[index].x, sorted[index + 1].y - sorted[index].y) > 0.1) {
        segments.push([sorted[index], sorted[index + 1]]);
      }
    }
  }
  return segments;
}

function architectureEntitiesToDxf(entities = [], limit = 45000) {
  const output = [];
  let count = 0;
  for (const entity of entities) {
    if (count >= limit) break;
    // Be defensive when the caller passes a mixed CAD collection: unsupported
    // or HATCH entities are skipped, rather than terminating all later
    // architecture export.
    if (!entity.points?.length || entity.type === 'HATCH') continue;
    const points = entity.points;
    for (let index = 0; index < points.length - 1; index += 1) {
      output.push(lineEntity('RT_ARCH', points[index], points[index + 1], 7));
      count += 1;
      if (count >= limit) break;
    }
    if (entity.closed && points.length > 2 && count < limit) {
      output.push(lineEntity('RT_ARCH', points.at(-1), points[0], 7));
      count += 1;
    }
  }
  return output.join('');
}

export function buildRoofTileDxf({
  pieces = [],
  regions = [],
  bands = [],
  groups = [],
  architectureEntities = [],
  settings = {},
  sourceFileName = ''
} = {}) {
  const layerDefs = [
    ['RT_ARCH', 7],
    ['RT_TILE_FULL', 140],
    ['RT_TILE_CUT', 30],
    ['RT_TILE_SMALL', 1],
    ['RT_TILE_CONT', 40],
    ['RT_TILE_HATCH', 8],
    ['RT_REGION', 3],
    ['RT_JOINT', 6],
    ['RT_DIM', 1],
    ['RT_ORIGIN', 2]
  ];
  const header = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009',
    '9', '$INSUNITS', '70', '4', '999', `Roof tile layout export from ${safeText(sourceFileName)}`,
    '0', 'ENDSEC', '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(layerDefs.length)];
  for (const [name, color] of layerDefs) header.push('0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', 'CONTINUOUS');
  header.push('0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');

  const entities = [architectureEntitiesToDxf(architectureEntities)];
  for (const band of bands.filter((item) => item.enabled !== false && item.visible !== false)) {
    const polygon = band.polygon?.length ? band.polygon : rectanglePolygon(band.minX, band.minY, band.maxX, band.maxY);
    entities.push(polylineEntity('RT_JOINT', polygon, 6));
    for (const [a, b] of hatchSegmentsForPolygon(polygon, 12)) entities.push(lineEntity('RT_JOINT', a, b, 6));
  }

  const dimensionRepresentatives = new Map();
  for (const piece of pieces) {
    const layer = piece.smallCut ? 'RT_TILE_SMALL' : piece.continuation ? 'RT_TILE_CONT' : piece.cut ? 'RT_TILE_CUT' : 'RT_TILE_FULL';
    const color = piece.smallCut ? 1 : piece.continuation ? 40 : piece.cut ? 30 : 140;
    entities.push(polylineEntity(layer, piece.polygon, color));
    const spacing = Math.max(60, Math.min(Number(piece.nominalWidth || 600), Number(piece.nominalHeight || 300)) / 4);
    for (const [a, b] of hatchSegmentsForPolygon(piece.polygon, spacing)) entities.push(lineEntity('RT_TILE_HATCH', a, b, piece.smallCut ? 1 : 8));
    if (piece.cut && settings.showCutLabels !== false) {
      const axis = cutDimensionAxis(piece);
      if (axis) {
        const value = axis === 'X' ? Number(piece.width) : Number(piece.height);
        const key = `${axis}:${Math.round(value)}`;
        const current = dimensionRepresentatives.get(key);
        if (!current || Number(piece.area || 0) > Number(current.piece.area || 0)) dimensionRepresentatives.set(key, { piece, axis, value });
      }
    }
  }

  const digits = 0;
  for (const { piece, axis, value } of dimensionRepresentatives.values()) {
    entities.push(...dimensionLineEntities(piece, axis, value, digits));
  }

  for (const region of regions.filter((item) => item.enabled !== false)) {
    entities.push(polylineEntity('RT_REGION', region.polygon, 3));
    for (const hole of region.holes || []) entities.push(polylineEntity('RT_REGION', hole, 3));
  }

  for (const group of groups) {
    const members = regions.filter((region) => region.groupId === group.id && region.enabled !== false);
    if (!members.length) continue;
    const x = Number(group.originX || 0) + Number(group.offsetX || 0) + Number(group.right || 0) - Number(group.left || 0);
    const y = Number(group.originY || 0) + Number(group.offsetY || 0) + Number(group.up || 0) - Number(group.down || 0);
    const size = 120;
    entities.push(lineEntity('RT_ORIGIN', { x: x - size, y }, { x: x + size, y }, 2));
    entities.push(lineEntity('RT_ORIGIN', { x, y: y - size }, { x, y: y + size }, 2));
    entities.push(textEntity('RT_ORIGIN', { x: x + size * 1.2, y: y + size * 1.2 }, group.name || group.id, 80, 2));
  }

  const footer = ['0', 'ENDSEC', '0', 'EOF'];
  return `${pairs(header)}${entities.join('')}${pairs(footer)}`;
}
