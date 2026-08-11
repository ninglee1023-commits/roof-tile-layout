import {
  absolutePolygonArea,
  bboxOfPoints,
  cleanPolygon,
  polylineVerticesWithBulges,
  polygonCentroid
} from './geometry.js';
import { parseAsciiDxf, summarizeLayers } from './dxf-parser.js';

const LIBREDWG_CANDIDATES = [
  {
    module: 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.7.9/dist/libredwg-web.js',
    wasm: 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.7.9/wasm/'
  },
  {
    module: 'https://unpkg.com/@mlightcad/libredwg-web@0.7.9/dist/libredwg-web.js',
    wasm: 'https://unpkg.com/@mlightcad/libredwg-web@0.7.9/wasm/'
  },
  {
    module: 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.7.7/dist/libredwg-web.js',
    wasm: 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.7.7/wasm/'
  }
];

function getPoint(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 2) return { x: Number(value[0]), y: Number(value[1]) };
  const x = Number(value.x ?? value.X ?? value[0]);
  const y = Number(value.y ?? value.Y ?? value[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function isClosedEntity(entity) {
  const type = String(entity.type || '').toUpperCase();
  const flag = Number(entity.flag ?? entity.flags ?? 0);
  if (type === 'LWPOLYLINE') return Boolean(flag & 512) || Boolean(flag & 1) || entity.closed === true;
  if (type.includes('POLYLINE')) return Boolean(flag & 1) || entity.closed === true;
  return entity.closed === true || type === 'CIRCLE' || type === 'ELLIPSE';
}

function normalizePolyline(entity) {
  const type = String(entity.type || '').toUpperCase();
  const rawVertices = entity.vertices || entity.points || entity.controlPoints || [];
  const vertices = [];
  for (const raw of rawVertices) {
    const point = getPoint(raw.position || raw.point || raw);
    if (!point) continue;
    point.bulge = Number(raw.bulge || 0);
    vertices.push(point);
  }
  const closed = isClosedEntity(entity);
  const points = closed ? polylineVerticesWithBulges(vertices, true, Math.PI / 24) : cleanPolygon(vertices);
  return {
    type,
    layer: entity.layer || entity.layerName || '0',
    handle: entity.handle || '',
    flag: Number(entity.flag ?? entity.flags ?? 0),
    closed,
    vertices,
    points
  };
}

function normalizeLine(entity) {
  const start = getPoint(entity.startPoint || entity.start || entity.startPosition || entity.point1);
  const end = getPoint(entity.endPoint || entity.end || entity.endPosition || entity.point2);
  if (!start || !end) return null;
  return { type: 'LINE', layer: entity.layer || entity.layerName || '0', handle: entity.handle || '', closed: false, points: [start, end], start, end };
}

function normalizeCircle(entity) {
  const center = getPoint(entity.center || entity.centerPoint);
  const radius = Math.abs(Number(entity.radius || 0));
  if (!center || !radius) return null;
  const points = [];
  for (let index = 0; index < 72; index += 1) {
    const angle = Math.PI * 2 * index / 72;
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return { type: 'CIRCLE', layer: entity.layer || '0', handle: entity.handle || '', closed: true, center, radius, points };
}

function normalizeArc(entity) {
  const center = getPoint(entity.center || entity.centerPoint);
  const radius = Math.abs(Number(entity.radius || 0));
  if (!center || !radius) return null;
  let start = Number(entity.startAngle ?? entity.start_angle ?? 0);
  let end = Number(entity.endAngle ?? entity.end_angle ?? 0);
  const radiansLikely = Math.abs(start) <= Math.PI * 2 + 0.01 && Math.abs(end) <= Math.PI * 2 + 0.01;
  if (!radiansLikely) { start *= Math.PI / 180; end *= Math.PI / 180; }
  while (end <= start) end += Math.PI * 2;
  const steps = Math.max(4, Math.ceil((end - start) / (Math.PI / 30)));
  const points = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = start + (end - start) * index / steps;
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return { type: 'ARC', layer: entity.layer || '0', handle: entity.handle || '', closed: false, center, radius, points };
}

export function normalizeDwgDatabase(database) {
  const output = [];
  for (const entity of database?.entities || []) {
    const type = String(entity.type || '').toUpperCase();
    let normalized = null;
    if (type.includes('POLYLINE')) normalized = normalizePolyline(entity);
    else if (type === 'LINE') normalized = normalizeLine(entity);
    else if (type === 'CIRCLE') normalized = normalizeCircle(entity);
    else if (type === 'ARC') normalized = normalizeArc(entity);
    if (normalized?.points?.length >= 2) output.push(normalized);
  }
  return { format: 'DWG', parser: 'libredwg-web', entities: output, layers: summarizeLayers(output), rawEntityCount: database?.entities?.length || 0 };
}

async function parseDwgWithCandidate(arrayBuffer, candidate, progress) {
  progress?.('正在載入 DWG 解碼器…');
  const module = await import(/* @vite-ignore */ candidate.module);
  const LibreDwg = module.LibreDwg || module.default?.LibreDwg;
  const DwgFileType = module.Dwg_File_Type || module.default?.Dwg_File_Type || { DWG: 0 };
  if (!LibreDwg?.create) throw new Error('DWG 模組未提供 LibreDwg.create。');
  progress?.('正在解碼 DWG；首次需要下載 WebAssembly…');
  const libredwg = await LibreDwg.create(candidate.wasm);
  let pointer;
  try {
    pointer = libredwg.dwg_read_data(arrayBuffer, DwgFileType.DWG ?? 0);
    if (!pointer) throw new Error('DWG 解碼器沒有返回圖形資料。');
    progress?.('正在轉換模型空間實體與圖層…');
    const database = libredwg.convert(pointer);
    return normalizeDwgDatabase(database);
  } finally {
    if (pointer) {
      try { libredwg.dwg_free(pointer); } catch { /* best effort */ }
    }
  }
}

export async function parseCadFile(fileOrBuffer, fileName = 'drawing.dwg', progress) {
  const arrayBuffer = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
  const extension = String(fileName).toLowerCase().split('.').pop();
  if (extension === 'dxf') {
    const text = new TextDecoder('utf-8').decode(arrayBuffer);
    progress?.('正在以內置 ASCII DXF 讀取器解析…');
    return parseAsciiDxf(text);
  }
  const errors = [];
  for (const candidate of LIBREDWG_CANDIDATES) {
    try { return await parseDwgWithCandidate(arrayBuffer, candidate, progress); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new Error(`DWG 解析失敗。可另存為 ASCII DXF 後匯入。\n${errors.join('\n')}`);
}

export function entitiesByLayer(cad, layer) {
  return (cad?.entities || []).filter((entity) => entity.layer === layer);
}

export function closedPolylinesByLayer(cad, layer) {
  return entitiesByLayer(cad, layer)
    .filter((entity) => entity.closed && entity.points?.length >= 3)
    .map((entity, index) => {
      const points = cleanPolygon(entity.points);
      return {
        ...entity,
        sourceIndex: index,
        points,
        bbox: bboxOfPoints(points),
        area: absolutePolygonArea(points),
        centroid: polygonCentroid(points)
      };
    })
    .filter((entity) => entity.area > 1);
}

export function inferLayer(cad, preferred, patterns = []) {
  const layers = cad?.layers || [];
  if (preferred && layers.some((layer) => layer.name.toUpperCase() === preferred.toUpperCase())) {
    return layers.find((layer) => layer.name.toUpperCase() === preferred.toUpperCase()).name;
  }
  for (const pattern of patterns) {
    const expression = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
    const found = layers.find((layer) => expression.test(layer.name));
    if (found) return found.name;
  }
  return layers.find((layer) => layer.closed > 0)?.name || layers[0]?.name || '';
}
