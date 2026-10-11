'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_ORIGINS = new Set((process.env.APP_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean));
const MAX_BODY_BYTES = 64 * 1024;

const staticFiles = new Map([
  ['/', ['frontend/index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['frontend/styles.css', 'text/css; charset=utf-8']],
  ['/config.js', ['frontend/config.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['frontend/app.js', 'text/javascript; charset=utf-8']],
]);

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      const error = new Error('Ukuran data terlalu besar.');
      error.status = 413;
      throw error;
    }
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    const error = new Error('Format JSON tidak valid.');
    error.status = 400;
    throw error;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const error = new Error('Data harus berupa objek JSON.');
    error.status = 400;
    throw error;
  }
  return payload;
}

async function supabase(pathname, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const error = new Error('Konfigurasi SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY belum diatur.');
    error.status = 503;
    throw error;
  }
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
      ...options,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  } catch (cause) {
    const error = new Error('Tidak dapat terhubung ke Supabase.');
    error.status = 502;
    error.cause = cause;
    throw error;
  }
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' ? data.message || data.details || data.hint : '';
    if (data?.code === '23503') {
      const error = new Error('Data tidak dapat dihapus karena sudah digunakan dalam transaksi. Riwayat transaksi tetap dipertahankan.');
      error.status = 409;
      throw error;
    }
    const error = new Error(message || `Permintaan database gagal (${response.status}).`);
    error.status = response.status >= 500 ? 502 : 400;
    throw error;
  }
  return data;
}

function requiredText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw Object.assign(new Error(`${label} wajib diisi (maksimal ${maxLength} karakter).`), { status: 400 });
  }
  return value.trim();
}

function optionalText(value, label, maxLength) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw Object.assign(new Error(`${label} maksimal ${maxLength} karakter.`), { status: 400 });
  }
  return value.trim() || null;
}

function nonNegativeAmount(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999999999.99 || !/^\d+(\.\d{1,2})?$/.test(String(value))) {
    throw Object.assign(new Error(`${label} harus berupa angka tidak negatif dengan maksimal 2 angka desimal.`), { status: 400 });
  }
  return amount;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validUuid(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw Object.assign(new Error(`${label} tidak valid.`), { status: 400 });
  }
  return value;
}

function transactionPayload(body) {
  if (!['purchase', 'sale'].includes(body.transaction_type)) {
    throw Object.assign(new Error('Jenis transaksi tidak valid.'), { status: 400 });
  }
  const partyId = validUuid(body.party_id, 'Pelanggan atau pemasok');
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
    throw Object.assign(new Error('Transaksi harus memiliki 1 sampai 100 rincian barang.'), { status: 400 });
  }
  const items = body.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw Object.assign(new Error('Rincian barang tidak valid.'), { status: 400 });
    }
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647) {
      throw Object.assign(new Error('Jumlah barang harus berupa bilangan bulat positif.'), { status: 400 });
    }
    return {
      spare_part_id: validUuid(item.spare_part_id, 'Sparepart'),
      quantity,
      unit_price: nonNegativeAmount(item.unit_price, 'Harga satuan'),
    };
  });
  if (!isValidDate(body.transaction_date)) {
    throw Object.assign(new Error('Tanggal transaksi tidak valid.'), { status: 400 });
  }
  return {
    p_transaction_type: body.transaction_type,
    p_party_id: partyId,
    p_transaction_date: body.transaction_date,
    p_notes: optionalText(body.notes, 'Catatan', 500),
    p_items: items,
  };
}

async function fetchAllPages(resource, pageSize = 1000) {
  const rows = [];
  const separator = resource.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += pageSize) {
    const page = await supabase(`${resource}${separator}limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  if (request.method === 'GET' && pathname === '/api/products') {
    return sendJson(response, 200, await fetchAllPages('spare_parts?select=id,sku,name,category,stock,cost_price,selling_price,is_active,created_at&is_active=eq.true&order=name.asc'));
  }
  if (request.method === 'GET' && pathname === '/api/parties') {
    return sendJson(response, 200, await fetchAllPages('parties?select=id,name,party_type,phone,created_at&order=name.asc'));
  }
  if (request.method === 'GET' && pathname === '/api/transactions') {
    return sendJson(response, 200, await supabase('transactions?select=id,transaction_type,transaction_date,total_amount,notes,party_id,parties(name),transaction_items(id,spare_part_id,line_number,quantity,unit_price,unit_cost,spare_parts(name,sku))&order=transaction_date.desc,created_at.desc&transaction_items.order=line_number.asc&limit=100'));
  }
  if (request.method === 'GET' && pathname === '/api/reports') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!isValidDate(from) || !isValidDate(to)) {
      throw Object.assign(new Error('Pilih tanggal awal dan akhir laporan yang valid.'), { status: 400 });
    }
    if (from > to) {
      throw Object.assign(new Error('Tanggal awal tidak boleh melewati tanggal akhir.'), { status: 400 });
    }
    const transactions = await fetchAllPages(`transactions?select=id,transaction_type,transaction_date,total_amount,notes,parties(name),transaction_items(quantity,unit_price,unit_cost,spare_parts(name,sku))&transaction_date=gte.${from}&transaction_date=lte.${to}&order=transaction_date.desc,created_at.desc,id.asc`);
    const summary = transactions.reduce((totals, transaction) => {
      if (transaction.transaction_type === 'sale') {
        totals.sales += Number(transaction.total_amount);
        totals.gross_profit += (transaction.transaction_items || []).reduce((sum, item) =>
          sum + (Number(item.unit_price) - Number(item.unit_cost)) * Number(item.quantity), 0);
      } else {
        totals.purchases += Number(transaction.total_amount);
      }
      return totals;
    }, { sales: 0, purchases: 0, gross_profit: 0 });
    return sendJson(response, 200, { from, to, transaction_count: transactions.length, ...summary, transactions });
  }
  if (request.method === 'GET' && pathname === '/api/dashboard') {
    const [products, transactions] = await Promise.all([
      fetchAllPages('spare_parts?select=stock&is_active=eq.true'),
      fetchAllPages('transactions?select=transaction_type,total_amount,transaction_items(quantity,unit_price,unit_cost)'),
    ]);
    const result = transactions.reduce((totals, transaction) => {
      if (transaction.transaction_type === 'sale') {
        totals.sales += Number(transaction.total_amount);
        totals.gross_profit += (transaction.transaction_items || []).reduce((sum, item) =>
          sum + (Number(item.unit_price) - Number(item.unit_cost)) * Number(item.quantity), 0);
      } else {
        totals.purchases += Number(transaction.total_amount);
      }
      return totals;
    }, { sales: 0, purchases: 0, gross_profit: 0 });
    return sendJson(response, 200, {
      ...result,
      product_count: products.length,
      low_stock_count: products.filter((product) => Number(product.stock) <= 5).length,
    });
  }
  if (request.method === 'POST' && pathname === '/api/products') {
    const body = await readJson(request);
    const product = {
      sku: requiredText(body.sku, 'SKU', 40),
      name: requiredText(body.name, 'Nama sparepart', 120),
      category: optionalText(body.category, 'Kategori', 80),
      selling_price: nonNegativeAmount(body.selling_price, 'Harga jual'),
    };
    const created = await supabase('spare_parts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(product),
    });
    return sendJson(response, 201, created[0]);
  }
  if (request.method === 'POST' && pathname === '/api/parties') {
    const body = await readJson(request);
    const partyType = body.party_type;
    if (!['customer', 'supplier', 'both'].includes(partyType)) {
      throw Object.assign(new Error('Peran kontak tidak valid.'), { status: 400 });
    }
    const party = {
      name: requiredText(body.name, 'Nama kontak', 120),
      party_type: partyType,
      phone: optionalText(body.phone, 'Nomor telepon', 30),
    };
    const created = await supabase('parties', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(party),
    });
    return sendJson(response, 201, created[0]);
  }
  const entityMatch = pathname.match(/^\/api\/(products|parties)\/([^/]+)$/);
  if (entityMatch && ['PATCH', 'DELETE'].includes(request.method)) {
    const [, entity, id] = entityMatch;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw Object.assign(new Error('ID data tidak valid.'), { status: 400 });
    }
    const table = entity === 'products' ? 'spare_parts' : 'parties';
    const query = `${table}?id=eq.${id}`;
    if (request.method === 'DELETE') {
      const deleted = await supabase(query, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      });
      if (!deleted.length) {
        throw Object.assign(new Error('Data tidak ditemukan atau sudah dihapus.'), { status: 404 });
      }
      return sendJson(response, 200, { id });
    }
    const body = await readJson(request);
    let updates;
    if (entity === 'products') {
      updates = {
        sku: requiredText(body.sku, 'SKU', 40),
        name: requiredText(body.name, 'Nama sparepart', 120),
        category: optionalText(body.category, 'Kategori', 80),
        selling_price: nonNegativeAmount(body.selling_price, 'Harga jual'),
      };
    } else {
      if (!['customer', 'supplier', 'both'].includes(body.party_type)) {
        throw Object.assign(new Error('Peran kontak tidak valid.'), { status: 400 });
      }
      updates = {
        name: requiredText(body.name, 'Nama kontak', 120),
        party_type: body.party_type,
        phone: optionalText(body.phone, 'Nomor telepon', 30),
      };
    }
    const updated = await supabase(query, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(updates),
    });
    if (!updated.length) {
      throw Object.assign(new Error('Data tidak ditemukan atau sudah dihapus.'), { status: 404 });
    }
    return sendJson(response, 200, updated[0]);
  }
  if (request.method === 'POST' && pathname === '/api/transactions') {
    const payload = transactionPayload(await readJson(request));
    const result = await supabase('rpc/create_transaction', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return sendJson(response, 201, { id: result });
  }
  const transactionMatch = pathname.match(/^\/api\/transactions\/([^/]+)$/);
  if (transactionMatch && ['PATCH', 'DELETE'].includes(request.method)) {
    const transactionId = validUuid(transactionMatch[1], 'ID transaksi');
    if (request.method === 'DELETE') {
      const deleted = await supabase('rpc/delete_transaction', {
        method: 'POST',
        body: JSON.stringify({ p_transaction_id: transactionId }),
      });
      return sendJson(response, 200, { id: deleted });
    }
    const payload = transactionPayload(await readJson(request));
    const updated = await supabase('rpc/update_transaction', {
      method: 'POST',
      body: JSON.stringify({ p_transaction_id: transactionId, ...payload }),
    });
    return sendJson(response, 200, { id: updated });
  }
  sendJson(response, 404, { error: 'Endpoint tidak ditemukan.' });
}

async function handleRequest(request, response) {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const origin = request.headers.origin;
      if (origin && APP_ORIGINS.has(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        if (!origin || !APP_ORIGINS.has(origin)) {
          sendJson(response, 403, { error: 'Origin aplikasi tidak diizinkan.' });
          return;
        }
        response.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        });
        response.end();
        return;
      }
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Metode tidak didukung.' });
      return;
    }
    const asset = staticFiles.get(url.pathname);
    if (!asset) {
      sendJson(response, 404, { error: 'Halaman tidak ditemukan.' });
      return;
    }
    const [relativePath, contentType] = asset;
    const content = await fs.readFile(path.join(ROOT, relativePath));
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (error.status >= 500) console.error(error);
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.message || 'Terjadi kesalahan pada server.' });
    else response.destroy();
  }
}

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`RodaKas berjalan pada http://localhost:${PORT}`);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('Supabase belum dikonfigurasi; API akan menampilkan error sampai variabel lingkungan diatur.');
  }
});
