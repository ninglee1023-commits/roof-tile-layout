export const EPS = 1e-7;

export function stableId(prefix = 'id') {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function numericValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function cleanPolygon(points = [], tolerance = 1e-6) {
  const output = [];
  for (const raw of points) {
    const point = { x: Number(raw?.x), y: Number(raw?.y) };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const last = output[output.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > tolerance) output.push(point);
  }
  if (output.length > 2) {
    const first = output[0];
    const last = output[output.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= tolerance) output.pop();
  }
  return output;
}

export function rectanglePolygon(minX, minY, maxX, maxY) {
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY }
  ];
}

export function bboxOfPoints(points = []) {
  if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, Number(point.x));
    minY = Math.min(minY, Number(point.y));
    maxX = Math.max(maxX, Number(point.x));
    maxY = Math.max(maxY, Number(point.y));
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function expandBBox(bbox, padding = 0) {
  return {
    minX: bbox.minX - padding,
    minY: bbox.minY - padding,
    maxX: bbox.maxX + padding,
    maxY: bbox.maxY + padding,
    width: bbox.width + padding * 2,
    height: bbox.height + padding * 2
  };
}

export function unionBBoxes(boxes = []) {
  if (!boxes.length) return { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000, width: 2000, height: 2000 };
  const minX = Math.min(...boxes.map((box) => box.minX));
  const minY = Math.min(...boxes.map((box) => box.minY));
  const maxX = Math.max(...boxes.map((box) => box.maxX));
  const maxY = Math.max(...boxes.map((box) => box.maxY));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function bboxesIntersect(a, b, tolerance = 0) {
  return a.maxX >= b.minX - tolerance && a.minX <= b.maxX + tolerance
    && a.maxY >= b.minY - tolerance && a.minY <= b.maxY + tolerance;
}

export function pointInBBox(point, bbox, tolerance = 0) {
  return point.x >= bbox.minX - tolerance && point.x <= bbox.maxX + tolerance
    && point.y >= bbox.minY - tolerance && point.y <= bbox.maxY + tolerance;
}

export function overlap1D(aMin, aMax, bMin, bMax) {
  return Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
}

export function signedPolygonArea(points = []) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

export function absolutePolygonArea(points = []) {
  return Math.abs(signedPolygonArea(points));
}

export function polygonCentroid(points = []) {
  if (!points.length) return { x: 0, y: 0 };
  const signedArea = signedPolygonArea(points);
  if (Math.abs(signedArea) < EPS) {
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length
    };
  }
  let x = 0;
  let y = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;
    x += (current.x + next.x) * cross;
    y += (current.y + next.y) * cross;
  }
  return { x: x / (6 * signedArea), y: y / (6 * signedArea) };
}

export function pointInPolygon(point, polygon = []) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || EPS) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function clipAgainst(points, inside, intersection) {
  const result = [];
  if (!points.length) return result;
  let previous = points[points.length - 1];
  let previousInside = inside(previous);
  for (const current of points) {
    const currentInside = inside(current);
    if (currentInside) {
      if (!previousInside) result.push(intersection(previous, current));
      result.push(current);
    } else if (previousInside) {
      result.push(intersection(previous, current));
    }
    previous = current;
    previousInside = currentInside;
  }
  return result;
}

export function clipPolygonToRect(polygon, rect) {
  let output = cleanPolygon(polygon);
  const intersectVertical = (x) => (a, b) => {
    const t = (x - a.x) / ((b.x - a.x) || EPS);
    return { x, y: a.y + (b.y - a.y) * t };
  };
  const intersectHorizontal = (y) => (a, b) => {
    const t = (y - a.y) / ((b.y - a.y) || EPS);
    return { x: a.x + (b.x - a.x) * t, y };
  };
  output = clipAgainst(output, (p) => p.x >= rect.minX - EPS, intersectVertical(rect.minX));
  output = clipAgainst(output, (p) => p.x <= rect.maxX + EPS, intersectVertical(rect.maxX));
  output = clipAgainst(output, (p) => p.y >= rect.minY - EPS, intersectHorizontal(rect.minY));
  output = clipAgainst(output, (p) => p.y <= rect.maxY + EPS, intersectHorizontal(rect.maxY));
  return cleanPolygon(output, 1e-5);
}

export function simplifyCollinear(points = [], tolerance = 0.01) {
  let output = cleanPolygon(points, tolerance * 0.01);
  if (output.length < 4) return output;
  let changed = true;
  while (changed && output.length >= 4) {
    changed = false;
    const next = [];
    for (let i = 0; i < output.length; i += 1) {
      const a = output[(i - 1 + output.length) % output.length];
      const b = output[i];
      const c = output[(i + 1) % output.length];
      const cross = Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
      const scale = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y));
      if (cross <= tolerance * scale) changed = true;
      else next.push(b);
    }
    if (next.length < 3) break;
    output = next;
  }
  return output;
}

export function isAxisAlignedRectangle(points = [], tolerance = 0.2) {
  const polygon = simplifyCollinear(points, tolerance);
  if (polygon.length !== 4) return false;
  for (let i = 0; i < 4; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % 4];
    if (Math.abs(a.x - b.x) > tolerance && Math.abs(a.y - b.y) > tolerance) return false;
  }
  return true;
}

function arcPointsFromBulge(start, end, bulge, maxAngleStep = Math.PI / 18) {
  if (Math.abs(bulge) < 1e-10) return [start, end];
  const chord = Math.hypot(end.x - start.x, end.y - start.y);
  if (chord < EPS) return [start, end];
  const sweep = 4 * Math.atan(bulge);
  const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const chordAngle = Math.atan2(end.y - start.y, end.x - start.x);
  const offset = Math.sqrt(Math.max(0, radius * radius - chord * chord / 4));
  const sign = bulge > 0 ? 1 : -1;
  const center = {
    x: mid.x - Math.sin(chordAngle) * offset * sign,
    y: mid.y + Math.cos(chordAngle) * offset * sign
  };
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const segments = Math.max(2, Math.ceil(Math.abs(sweep) / maxAngleStep));
  const points = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = startAngle + sweep * (i / segments);
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return points;
}

export function polylineVerticesWithBulges(vertices = [], closed = false, maxAngleStep = Math.PI / 18) {
  if (vertices.length < 2) return cleanPolygon(vertices);
  const output = [];
  const segmentCount = closed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < segmentCount; i += 1) {
    const start = vertices[i];
    const end = vertices[(i + 1) % vertices.length];
    const segment = arcPointsFromBulge(start, end, Number(start.bulge || 0), maxAngleStep);
    if (i) segment.shift();
    output.push(...segment);
  }
  return cleanPolygon(output);
}

export function formatMm(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toLocaleString('zh-HK', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function csvEscape(value) {
  const string = String(value ?? '');
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

export function escapeXml(value) {
  return escapeHtml(value);
}

export function downloadBlob(content, fileName, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
