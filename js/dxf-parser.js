import { cleanPolygon, polylineVerticesWithBulges } from './geometry.js';

const MAX_INSERT_DEPTH = 12;
const MAX_EXPANDED_ENTITIES = 160000;

function normalizeCode(raw) {
  const code = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(code) ? code : null;
}

function pairLines(text) {
  const lines = String(text).replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const pairs = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = normalizeCode(lines[index]);
    if (code === null) continue;
    pairs.push({ code, value: lines[index + 1] ?? '' });
  }
  return pairs;
}

function numeric(value, fallback = 0) {
  const result = Number.parseFloat(String(value).trim());
  return Number.isFinite(result) ? result : fallback;
}

function integer(value, fallback = 0) {
  const result = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(result) ? result : fallback;
}

function normalizedLayer(value) {
  return String(value || '0').trim() || '0';
}

function parseCommon(record, entity) {
  for (const item of record) {
    if (item.code === 5) entity.handle = item.value.trim();
    else if (item.code === 8) entity.layer = normalizedLayer(item.value);
    else if (item.code === 67) entity.paperSpace = integer(item.value, 0) === 1;
    else if (item.code === 410) entity.layout = item.value.trim();
  }
  return entity;
}

function parseLWPolyline(record) {
  const entity = parseCommon(record, { type: 'LWPOLYLINE', layer: '0', flag: 0, vertices: [], closed: false });
  let current = null;
  for (const item of record) {
    switch (item.code) {
      case 70:
        entity.flag = integer(item.value, 0);
        entity.closed = Boolean(entity.flag & 1);
        break;
      case 10:
        current = { x: numeric(item.value), y: 0, bulge: 0 };
        entity.vertices.push(current);
        break;
      case 20: if (current) current.y = numeric(item.value); break;
      case 42: if (current) current.bulge = numeric(item.value); break;
      default: break;
    }
  }
  entity.points = entity.closed ? polylineVerticesWithBulges(entity.vertices, true) : cleanPolygon(entity.vertices);
  return entity;
}

function parseLine(record) {
  const entity = parseCommon(record, { type: 'LINE', layer: '0', start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, closed: false });
  for (const item of record) {
    switch (item.code) {
      case 10: entity.start.x = numeric(item.value); break;
      case 20: entity.start.y = numeric(item.value); break;
      case 11: entity.end.x = numeric(item.value); break;
      case 21: entity.end.y = numeric(item.value); break;
      default: break;
    }
  }
  entity.points = [entity.start, entity.end];
  return entity;
}

function parseCircle(record) {
  const entity = parseCommon(record, { type: 'CIRCLE', layer: '0', center: { x: 0, y: 0 }, radius: 0, closed: true, points: [] });
  for (const item of record) {
    switch (item.code) {
      case 10: entity.center.x = numeric(item.value); break;
      case 20: entity.center.y = numeric(item.value); break;
      case 40: entity.radius = Math.abs(numeric(item.value)); break;
      default: break;
    }
  }
  for (let index = 0; index < 72; index += 1) {
    const angle = Math.PI * 2 * index / 72;
    entity.points.push({ x: entity.center.x + Math.cos(angle) * entity.radius, y: entity.center.y + Math.sin(angle) * entity.radius });
  }
  return entity;
}

function parseArc(record) {
  const entity = parseCommon(record, { type: 'ARC', layer: '0', center: { x: 0, y: 0 }, radius: 0, startAngle: 0, endAngle: 0, closed: false, points: [] });
  for (const item of record) {
    switch (item.code) {
      case 10: entity.center.x = numeric(item.value); break;
      case 20: entity.center.y = numeric(item.value); break;
      case 40: entity.radius = Math.abs(numeric(item.value)); break;
      case 50: entity.startAngle = numeric(item.value); break;
      case 51: entity.endAngle = numeric(item.value); break;
      default: break;
    }
  }
  let sweep = entity.endAngle - entity.startAngle;
  while (sweep <= 0) sweep += 360;
  const segments = Math.max(4, Math.ceil(sweep / 6));
  for (let index = 0; index <= segments; index += 1) {
    const angle = (entity.startAngle + sweep * index / segments) * Math.PI / 180;
    entity.points.push({ x: entity.center.x + Math.cos(angle) * entity.radius, y: entity.center.y + Math.sin(angle) * entity.radius });
  }
  return entity;
}

function parseEllipse(record) {
  const entity = parseCommon(record, {
    type: 'ELLIPSE', layer: '0', center: { x: 0, y: 0 }, major: { x: 1, y: 0 }, ratio: 1,
    startParameter: 0, endParameter: Math.PI * 2, closed: true, points: []
  });
  for (const item of record) {
    switch (item.code) {
      case 10: entity.center.x = numeric(item.value); break;
      case 20: entity.center.y = numeric(item.value); break;
      case 11: entity.major.x = numeric(item.value); break;
      case 21: entity.major.y = numeric(item.value); break;
      case 40: entity.ratio = Math.abs(numeric(item.value, 1)); break;
      case 41: entity.startParameter = numeric(item.value, 0); break;
      case 42: entity.endParameter = numeric(item.value, Math.PI * 2); break;
      default: break;
    }
  }
  let sweep = entity.endParameter - entity.startParameter;
  while (sweep <= 0) sweep += Math.PI * 2;
  entity.closed = Math.abs(sweep - Math.PI * 2) < 1e-6;
  const majorLength = Math.hypot(entity.major.x, entity.major.y) || 1;
  const minorLength = majorLength * entity.ratio;
  const ux = entity.major.x / majorLength;
  const uy = entity.major.y / majorLength;
  const minor = { x: -uy * minorLength, y: ux * minorLength };
  const segments = Math.max(12, Math.ceil(sweep / (Math.PI / 30)));
  for (let index = 0; index <= segments; index += 1) {
    const parameter = entity.startParameter + sweep * index / segments;
    entity.points.push({
      x: entity.center.x + entity.major.x * Math.cos(parameter) + minor.x * Math.sin(parameter),
      y: entity.center.y + entity.major.y * Math.cos(parameter) + minor.y * Math.sin(parameter)
    });
  }
  if (entity.closed && entity.points.length > 1) entity.points.pop();
  return entity;
}


function approximateCircularArc(center, radius, startDegrees, endDegrees, counterClockwise = true) {
  let start = Number(startDegrees || 0) * Math.PI / 180;
  let end = Number(endDegrees || 0) * Math.PI / 180;
  if (counterClockwise) while (end <= start) end += Math.PI * 2;
  else while (end >= start) end -= Math.PI * 2;
  const sweep = end - start;
  const segments = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
  const points = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = start + sweep * index / segments;
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return points;
}

function parseHatch(record) {
  const entity = parseCommon(record, {
    type: 'HATCH', layer: '0', patternName: '', closed: true, points: [], boundaryPaths: []
  });
  for (const item of record) if (item.code === 2 && !entity.patternName) entity.patternName = item.value.trim();

  let index = 0;
  while (index < record.length) {
    if (record[index].code !== 92) { index += 1; continue; }
    const flags = integer(record[index].value, 0);
    index += 1;
    let points = [];
    let closed = true;

    if (flags & 2) {
      let vertexCount = 0;
      const vertices = [];
      while (index < record.length && record[index].code !== 93 && ![92, 75, 98].includes(record[index].code)) {
        if (record[index].code === 73) closed = integer(record[index].value, 1) !== 0;
        index += 1;
      }
      if (record[index]?.code === 93) {
        vertexCount = Math.max(0, integer(record[index].value, 0));
        index += 1;
      }
      for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
        while (index < record.length && record[index].code !== 10 && ![92, 75, 98, 97].includes(record[index].code)) index += 1;
        if (record[index]?.code !== 10) break;
        const vertex = { x: numeric(record[index].value), y: 0, bulge: 0 };
        index += 1;
        while (index < record.length && ![10, 92, 75, 98, 97].includes(record[index].code)) {
          if (record[index].code === 20) vertex.y = numeric(record[index].value);
          else if (record[index].code === 42) vertex.bulge = numeric(record[index].value);
          index += 1;
        }
        vertices.push(vertex);
      }
      points = closed ? polylineVerticesWithBulges(vertices, true, Math.PI / 24) : cleanPolygon(vertices);
    } else {
      while (index < record.length && record[index].code !== 93 && ![92, 75, 98].includes(record[index].code)) index += 1;
      const edgeCount = record[index]?.code === 93 ? Math.max(0, integer(record[index].value, 0)) : 0;
      if (record[index]?.code === 93) index += 1;
      const edgePoints = [];
      for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex += 1) {
        while (index < record.length && record[index].code !== 72 && ![92, 75, 98, 97].includes(record[index].code)) index += 1;
        if (record[index]?.code !== 72) break;
        const edgeType = integer(record[index].value, 0);
        index += 1;
        const values = new Map();
        while (index < record.length && ![72, 92, 75, 98, 97].includes(record[index].code)) {
          values.set(record[index].code, record[index].value);
          index += 1;
        }
        let segment = [];
        if (edgeType === 1) {
          segment = [
            { x: numeric(values.get(10)), y: numeric(values.get(20)) },
            { x: numeric(values.get(11)), y: numeric(values.get(21)) }
          ];
        } else if (edgeType === 2) {
          segment = approximateCircularArc(
            { x: numeric(values.get(10)), y: numeric(values.get(20)) },
            Math.abs(numeric(values.get(40))),
            numeric(values.get(50)), numeric(values.get(51)), integer(values.get(73), 1) !== 0
          );
        }
        for (const point of segment) {
          const last = edgePoints[edgePoints.length - 1];
          if (!last || Math.hypot(last.x - point.x, last.y - point.y) > 1e-6) edgePoints.push(point);
        }
      }
      points = cleanPolygon(edgePoints);
    }

    const cleaned = cleanPolygon(points);
    if (cleaned.length >= 3) entity.boundaryPaths.push({ flags, closed, points: cleaned });
    while (index < record.length && ![92, 75, 98].includes(record[index].code)) index += 1;
  }

  if (!entity.boundaryPaths.length) return null;
  const preferred = entity.boundaryPaths.filter((path) => !(path.flags & 8));
  const source = preferred.length ? preferred : entity.boundaryPaths;
  entity.points = source
    .slice()
    .sort((a, b) => Math.abs(b.points.reduce((sum, point, i) => {
      const next = b.points[(i + 1) % b.points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0)) - Math.abs(a.points.reduce((sum, point, i) => {
      const next = a.points[(i + 1) % a.points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0)))[0].points;
  return entity;
}

function parseInsert(record) {
  const entity = parseCommon(record, {
    type: 'INSERT', layer: '0', blockName: '', insertion: { x: 0, y: 0 },
    scaleX: 1, scaleY: 1, rotation: 0,
    columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0
  });
  for (const item of record) {
    switch (item.code) {
      case 2: entity.blockName = item.value.trim(); break;
      case 10: entity.insertion.x = numeric(item.value); break;
      case 20: entity.insertion.y = numeric(item.value); break;
      case 41: entity.scaleX = numeric(item.value, 1) || 1; break;
      case 42: entity.scaleY = numeric(item.value, 1) || 1; break;
      case 50: entity.rotation = numeric(item.value, 0); break;
      case 70: entity.columns = Math.max(1, integer(item.value, 1)); break;
      case 71: entity.rows = Math.max(1, integer(item.value, 1)); break;
      case 44: entity.columnSpacing = numeric(item.value, 0); break;
      case 45: entity.rowSpacing = numeric(item.value, 0); break;
      default: break;
    }
  }
  return entity;
}

function parseClassicPolyline(pairs, startIndex) {
  const header = [];
  let index = startIndex + 1;
  while (index < pairs.length && pairs[index].code !== 0) header.push(pairs[index++]);
  const entity = parseCommon(header, { type: 'POLYLINE', layer: '0', flag: 0, vertices: [], closed: false });
  for (const item of header) if (item.code === 70) entity.flag = integer(item.value, 0);
  while (index < pairs.length) {
    const marker = pairs[index];
    if (marker.code !== 0) { index += 1; continue; }
    const type = marker.value.trim().toUpperCase();
    if (type === 'SEQEND') {
      index += 1;
      while (index < pairs.length && pairs[index].code !== 0) index += 1;
      break;
    }
    if (type !== 'VERTEX') break;
    index += 1;
    const record = [];
    while (index < pairs.length && pairs[index].code !== 0) record.push(pairs[index++]);
    const vertex = { x: 0, y: 0, bulge: 0 };
    for (const item of record) {
      if (item.code === 8) entity.layer = normalizedLayer(item.value);
      if (item.code === 10) vertex.x = numeric(item.value);
      if (item.code === 20) vertex.y = numeric(item.value);
      if (item.code === 42) vertex.bulge = numeric(item.value);
    }
    entity.vertices.push(vertex);
  }
  entity.closed = Boolean(entity.flag & 1);
  entity.points = entity.closed ? polylineVerticesWithBulges(entity.vertices, true) : cleanPolygon(entity.vertices);
  return { entity, nextIndex: index };
}

function parseEntityAt(pairs, startIndex) {
  const marker = pairs[startIndex];
  if (!marker || marker.code !== 0) return { entity: null, nextIndex: startIndex + 1 };
  const type = marker.value.trim().toUpperCase();
  if (type === 'POLYLINE') return parseClassicPolyline(pairs, startIndex);
  const record = [];
  let index = startIndex + 1;
  while (index < pairs.length && pairs[index].code !== 0) record.push(pairs[index++]);
  let entity = null;
  if (type === 'LWPOLYLINE') entity = parseLWPolyline(record);
  else if (type === 'LINE') entity = parseLine(record);
  else if (type === 'CIRCLE') entity = parseCircle(record);
  else if (type === 'ARC') entity = parseArc(record);
  else if (type === 'ELLIPSE') entity = parseEllipse(record);
  else if (type === 'HATCH') entity = parseHatch(record);
  else if (type === 'INSERT') entity = parseInsert(record);
  return { entity, nextIndex: index };
}

function parseBlockHeader(pairs, startIndex) {
  const record = [];
  let index = startIndex + 1;
  while (index < pairs.length && pairs[index].code !== 0) record.push(pairs[index++]);
  const block = { name: '', layer: '0', base: { x: 0, y: 0 }, entities: [] };
  for (const item of record) {
    if (item.code === 2) block.name = item.value.trim();
    else if (item.code === 8) block.layer = normalizedLayer(item.value);
    else if (item.code === 10) block.base.x = numeric(item.value);
    else if (item.code === 20) block.base.y = numeric(item.value);
  }
  return { block, nextIndex: index };
}

function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrices(parent, child) {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    e: parent.a * child.e + parent.c * child.f + parent.e,
    f: parent.b * child.e + parent.d * child.f + parent.f
  };
}

function transformPoint(point, matrix) {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f
  };
}

function insertMatrix(insert, block, column = 0, row = 0) {
  const radians = Number(insert.rotation || 0) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const scaleX = Number(insert.scaleX || 1);
  const scaleY = Number(insert.scaleY || 1);
  const offsetX = column * Number(insert.columnSpacing || 0) - Number(block.base.x || 0);
  const offsetY = row * Number(insert.rowSpacing || 0) - Number(block.base.y || 0);
  const a = cosine * scaleX;
  const b = sine * scaleX;
  const c = -sine * scaleY;
  const d = cosine * scaleY;
  return {
    a, b, c, d,
    e: Number(insert.insertion.x || 0) + a * offsetX + c * offsetY,
    f: Number(insert.insertion.y || 0) + b * offsetX + d * offsetY
  };
}

function transformGeometry(entity, matrix, inheritedLayer) {
  const points = (entity.points || []).map((point) => transformPoint(point, matrix));
  if (points.length < 2) return null;
  const layer = normalizedLayer(entity.layer) === '0' ? normalizedLayer(inheritedLayer) : normalizedLayer(entity.layer);
  const boundaryPaths = (entity.boundaryPaths || []).map((path) => ({
    ...path,
    points: (path.points || []).map((point) => transformPoint(point, matrix))
  }));
  return {
    ...entity,
    layer,
    points,
    boundaryPaths,
    vertices: undefined,
    sourceBlock: entity.sourceBlock || null,
    transformedFromBlock: true
  };
}

function blockLookup(blocks, name) {
  if (blocks.has(name)) return blocks.get(name);
  const upper = String(name || '').toUpperCase();
  for (const [key, block] of blocks) if (key.toUpperCase() === upper) return block;
  return null;
}

function expandInsert(insert, blocks, output, diagnostics, parentMatrix = identityMatrix(), inheritedLayer = '0', depth = 0, stack = []) {
  if (!insert?.blockName || depth > MAX_INSERT_DEPTH || output.length >= MAX_EXPANDED_ENTITIES) {
    diagnostics.skippedInserts += 1;
    return;
  }
  const block = blockLookup(blocks, insert.blockName);
  if (!block || stack.includes(block.name)) {
    diagnostics.missingBlocks += block ? 0 : 1;
    diagnostics.skippedInserts += 1;
    return;
  }
  const effectiveInsertLayer = normalizedLayer(insert.layer) === '0' ? normalizedLayer(inheritedLayer) : normalizedLayer(insert.layer);
  for (let row = 0; row < Math.max(1, insert.rows || 1); row += 1) {
    for (let column = 0; column < Math.max(1, insert.columns || 1); column += 1) {
      const matrix = multiplyMatrices(parentMatrix, insertMatrix(insert, block, column, row));
      for (const entity of block.entities) {
        if (output.length >= MAX_EXPANDED_ENTITIES) break;
        if (entity.type === 'INSERT') {
          expandInsert(entity, blocks, output, diagnostics, matrix, effectiveInsertLayer, depth + 1, [...stack, block.name]);
          continue;
        }
        const transformed = transformGeometry({ ...entity, sourceBlock: block.name }, matrix, effectiveInsertLayer);
        if (transformed) output.push(transformed);
      }
      diagnostics.expandedInsertInstances += 1;
    }
  }
}

export function summarizeLayers(entities) {
  const counts = new Map();
  for (const entity of entities) {
    const layer = entity.layer || '0';
    const current = counts.get(layer) || { name: layer, entities: 0, closed: 0, polylines: 0, lines: 0, hatches: 0 };
    current.entities += 1;
    if (entity.closed) current.closed += 1;
    if (String(entity.type).includes('POLYLINE')) current.polylines += 1;
    if (entity.type === 'LINE') current.lines += 1;
    if (entity.type === 'HATCH') current.hatches += 1;
    counts.set(layer, current);
  }
  return [...counts.values()].sort((a, b) => b.entities - a.entities || a.name.localeCompare(b.name));
}

export function parseAsciiDxf(text) {
  const header = String(text).slice(0, 64).toUpperCase();
  if (header.includes('AUTOCAD BINARY DXF')) throw new Error('內置讀取器只支援 ASCII DXF。請在 AutoCAD 另存為 ASCII DXF。');
  const pairs = pairLines(text);
  const blocks = new Map();
  const topLevel = [];
  let section = '';
  let rawEntityCount = 0;

  for (let index = 0; index < pairs.length;) {
    const item = pairs[index];
    const value = item.value.trim().toUpperCase();
    if (item.code === 0 && value === 'SECTION') {
      const next = pairs[index + 1];
      section = next?.code === 2 ? next.value.trim().toUpperCase() : '';
      index += 2;
      continue;
    }
    if (item.code === 0 && value === 'ENDSEC') {
      section = '';
      index += 1;
      continue;
    }
    if (section === 'BLOCKS' && item.code === 0 && value === 'BLOCK') {
      const parsedHeader = parseBlockHeader(pairs, index);
      const block = parsedHeader.block;
      index = parsedHeader.nextIndex;
      while (index < pairs.length) {
        const marker = pairs[index];
        const markerValue = marker.value.trim().toUpperCase();
        if (marker.code === 0 && markerValue === 'ENDBLK') {
          index += 1;
          while (index < pairs.length && pairs[index].code !== 0) index += 1;
          break;
        }
        if (marker.code !== 0) { index += 1; continue; }
        const parsed = parseEntityAt(pairs, index);
        if (parsed.entity) block.entities.push(parsed.entity);
        index = parsed.nextIndex;
      }
      if (block.name) blocks.set(block.name, block);
      continue;
    }
    if (section === 'ENTITIES' && item.code === 0) {
      const parsed = parseEntityAt(pairs, index);
      rawEntityCount += 1;
      if (parsed.entity && !parsed.entity.paperSpace) topLevel.push(parsed.entity);
      index = parsed.nextIndex;
      continue;
    }
    index += 1;
  }

  const entities = [];
  const diagnostics = { expandedInsertInstances: 0, skippedInserts: 0, missingBlocks: 0 };
  for (const entity of topLevel) {
    if (entity.type === 'INSERT') expandInsert(entity, blocks, entities, diagnostics, identityMatrix(), entity.layer || '0');
    else if (entity.points?.length >= 2) entities.push(entity);
  }
  if (!entities.length) throw new Error('DXF 內未找到可讀取的模型空間線段、多段線或可展開圖塊。');
  return {
    format: 'DXF',
    parser: 'built-in-ascii-dxf',
    entities,
    layers: summarizeLayers(entities),
    rawEntityCount,
    blockCount: blocks.size,
    ...diagnostics
  };
}
