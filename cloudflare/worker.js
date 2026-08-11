const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS roof_tile_sync (
  sync_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;
const MAX_SYNC_BYTES = 900000;
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
  if (!['get', 'put'].includes(action)) return jsonResponse({ ok: false, message: '不支援的同步操作。' }, 400);

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
