const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS roof_tile_sync (
  sync_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;
const SOURCE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS roof_tile_sync_source (
  sync_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  source_file_name TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sync_key, source_id, chunk_index)
)`;
const MAX_SYNC_BYTES = 4000000;
const MAX_SOURCE_CHUNK_BYTES = 600000;
let schemaReady = false;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}

async function hashSyncKey(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(SCHEMA_SQL).run();
  await db.prepare(SOURCE_SCHEMA_SQL).run();
  schemaReady = true;
}

async function handleSync(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  }});
  if (request.method !== 'POST') return jsonResponse({ ok: false, message: '只接受 POST 請求。' }, 405);
  if (!env.DB) return jsonResponse({ ok: false, message: '同步資料庫尚未連接。' }, 503);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ ok: false, message: '同步資料格式無效。' }, 400); }

  const syncKey = String(body?.syncKey || '').trim();
  const action = String(body?.action || '').toLowerCase();
  if (syncKey.length < 6 || syncKey.length > 128) {
    return jsonResponse({ ok: false, message: '同步碼長度必須為 6 至 128 個字元。' }, 400);
  }
  if (!['get', 'put', 'get-source', 'put-source'].includes(action)) return jsonResponse({ ok: false, message: '不支援的同步操作。' }, 400);

  try {
    await ensureSchema(env.DB);
    const key = await hashSyncKey(syncKey);
    if (action === 'get') {
      const row = await env.DB.prepare(
        'SELECT payload, updated_at FROM roof_tile_sync WHERE sync_key = ?1'
      ).bind(key).first();
      if (!row) return jsonResponse({ ok: false, message: '找不到這個同步碼的資料。' }, 404);
      return jsonResponse({ ok: true, payload: JSON.parse(row.payload), updatedAt: row.updated_at });
    }

    if (action === 'get-source') {
      const sourceId = String(body?.payload?.sourceId || '').trim();
      const chunkIndex = Number(body?.payload?.chunkIndex);
      if (!/^[a-f0-9]{64}$/i.test(sourceId) || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
        return jsonResponse({ ok: false, message: '無效的 CAD 底圖分片索引。' }, 400);
      }
      const row = await env.DB.prepare(
        `SELECT source_id, chunk_index, chunk_count, source_file_name, data, updated_at
         FROM roof_tile_sync_source WHERE sync_key = ?1 AND source_id = ?2 AND chunk_index = ?3`
      ).bind(key, sourceId, chunkIndex).first();
      if (!row) return jsonResponse({ ok: false, message: '找不到同步的 CAD 底圖。' }, 404);
      return jsonResponse({
        ok: true,
        sourceId: row.source_id,
        chunkIndex: row.chunk_index,
        chunkCount: row.chunk_count,
        sourceFileName: row.source_file_name,
        data: row.data,
        updatedAt: row.updated_at
      });
    }

    if (action === 'put-source') {
      const source = body?.payload || {};
      const sourceId = String(source.sourceId || '').trim();
      const chunkIndex = Number(source.chunkIndex);
      const chunkCount = Number(source.chunkCount);
      const sourceFileName = String(source.sourceFileName || 'drawing.dxf').slice(0, 240);
      const data = String(source.data || '');
      if (!/^[a-f0-9]{64}$/i.test(sourceId)
        || !Number.isInteger(chunkIndex) || chunkIndex < 0
        || !Number.isInteger(chunkCount) || chunkCount < 1 || chunkIndex >= chunkCount
        || !data || data.length > MAX_SOURCE_CHUNK_BYTES) {
        return jsonResponse({ ok: false, message: '無效的 CAD 底圖同步分片。' }, 400);
      }
      const sourceUpdatedAt = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO roof_tile_sync_source
        (sync_key, source_id, chunk_index, chunk_count, source_file_name, data, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(sync_key, source_id, chunk_index) DO UPDATE SET
          chunk_count = excluded.chunk_count,
          source_file_name = excluded.source_file_name,
          data = excluded.data,
          updated_at = excluded.updated_at`)
        .bind(key, sourceId, chunkIndex, chunkCount, sourceFileName, data, sourceUpdatedAt).run();
      return jsonResponse({ ok: true, sourceId, chunkIndex, chunkCount, updatedAt: sourceUpdatedAt });
    }

    const payload = body?.payload;
    if (!payload || payload.projectType !== 'roof-tile-layout-sync') {
      return jsonResponse({ ok: false, message: '同步內容格式無效。' }, 400);
    }
    const payloadText = JSON.stringify(payload);
    if (new TextEncoder().encode(payloadText).byteLength > MAX_SYNC_BYTES) {
      return jsonResponse({ ok: false, message: '同步內容過大，請先使用 JSON 備份或減少來源資料。' }, 413);
    }
    const updatedAt = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO roof_tile_sync (sync_key, payload, updated_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(sync_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .bind(key, payloadText, updatedAt).run();
    return jsonResponse({ ok: true, updatedAt });
  } catch (error) {
    console.error('sync request failed', error);
    return jsonResponse({ ok: false, message: '同步服務暫時發生錯誤。' }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/sync') return handleSync(request, env);
    if (url.pathname === '/__roof_tile_health') return new Response('ok');
    return new Response('Roof Tile Layout Sync Worker', { status: 200 });
  }
};
