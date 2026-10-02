const rupiah = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value || 0));
const dateFormatter = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' });
const state = { parts: [], transactions: [], view: 'overview' };
const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Permintaan gagal.');
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(notify.timeout);
  notify.timeout = window.setTimeout(() => toast.classList.remove('show'), 2600);
}

function transactionLabel(type) {
  return type === 'sale' ? 'Penjualan' : 'Pembelian stok';
}

function renderSummary(summary) {
  $('#metric-stock-value').textContent = rupiah(summary.stock_value);
  $('#metric-stock-units').textContent = Number(summary.stock_units).toLocaleString('id-ID');
  $('#metric-part-count').textContent = Number(summary.part_count).toLocaleString('id-ID');
  $('#metric-sales').textContent = rupiah(summary.sales_total);
  $('#metric-today').textContent = Number(summary.transactions_today).toLocaleString('id-ID');
}

function renderParts() {
  const matchingParts = state.parts.filter((part) => `${part.name} ${part.code} ${part.category}`.toLowerCase().includes($('#part-search').value.toLowerCase()));
  $('#inventory-count').textContent = `${matchingParts.length} item`;
  $('#inventory-parts').innerHTML = matchingParts.map((part) => `<tr>
    <td><span class="part-code">${escapeHtml(part.code)}</span></td>
    <td><span class="part-name">${escapeHtml(part.name)}</span></td>
    <td>${escapeHtml(part.category)}</td>
    <td><span class="stock-badge ${part.stock <= 3 ? 'low' : ''}">${Number(part.stock).toLocaleString('id-ID')} unit</span></td>
    <td>${rupiah(part.purchase_price)}</td><td>${rupiah(part.selling_price)}</td>
    <td><button class="row-action" data-delete-part="${escapeHtml(part.id)}" title="Hapus sparepart" aria-label="Hapus ${escapeHtml(part.name)}">×</button></td>
  </tr>`).join('');
  $('#inventory-empty').classList.toggle('hidden', matchingParts.length > 0);
  const overviewParts = state.parts.slice(0, 6);
  $('#overview-parts').innerHTML = overviewParts.map((part) => `<tr>
    <td><span class="part-name">${escapeHtml(part.name)}</span><span class="part-code">${escapeHtml(part.code)}</span></td>
    <td>${escapeHtml(part.category)}</td>
    <td><span class="stock-badge ${part.stock <= 3 ? 'low' : ''}">${Number(part.stock).toLocaleString('id-ID')}</span></td>
    <td>${rupiah(part.selling_price)}</td>
  </tr>`).join('');
  $('#overview-empty').classList.toggle('hidden', overviewParts.length > 0);
  const selected = $('#transaction-part').value;
  $('#transaction-part').innerHTML = '<option value="">Pilih sparepart...</option>' + state.parts.map((part) => `<option value="${escapeHtml(part.id)}">${escapeHtml(part.name)} (${Number(part.stock)} tersedia)</option>`).join('');
  if (state.parts.some((part) => part.id === selected)) $('#transaction-part').value = selected;
  updateTransactionPrice();
}

function renderTransactions() {
  const renderRecent = state.transactions.slice(0, 5);
  const recentMarkup = renderRecent.map((transaction) => `<div class="recent-item">
    <span class="recent-icon ${transaction.type}">${transaction.type === 'sale' ? '↗' : '↙'}</span>
    <div class="recent-copy"><strong>${transactionLabel(transaction.type)}</strong><small>${dateFormatter.format(new Date(transaction.transaction_date))} · ${transaction.transaction_items?.length || 0} item</small></div>
    <div class="recent-amount">${rupiah(transaction.total)}<small>${timeFormatter.format(new Date(transaction.transaction_date))}</small></div>
  </div>`).join('');
  $('#recent-transactions').innerHTML = recentMarkup;
  $('#transactions-empty').classList.toggle('hidden', renderRecent.length > 0);
  $('#transaction-history').innerHTML = state.transactions.map((transaction) => {
    const items = (transaction.transaction_items || []).map((item) => `${item.spareparts?.name || 'Sparepart'} × ${item.quantity}`).join(', ');
    return `<article class="history-entry">
      <span class="history-icon ${transaction.type}">${transaction.type === 'sale' ? '↗' : '↙'}</span>
      <div class="history-description"><strong>${transactionLabel(transaction.type)}${transaction.note ? ` · ${escapeHtml(transaction.note)}` : ''}</strong><small>${dateFormatter.format(new Date(transaction.transaction_date))} · ${escapeHtml(items)}</small></div>
      <div class="history-total">${rupiah(transaction.total)}<small>${timeFormatter.format(new Date(transaction.transaction_date))}</small></div>
    </article>`;
  }).join('');
  $('#history-empty').classList.toggle('hidden', state.transactions.length > 0);
}

function updateTransactionPrice() {
  const part = state.parts.find((item) => item.id === $('#transaction-part').value);
  const price = part ? Number($('#transaction-type').value === 'sale' ? part.selling_price : part.purchase_price) : 0;
  const quantity = Math.max(0, Number($('#transaction-quantity').value) || 0);
  $('#unit-price').textContent = rupiah(price);
  $('#transaction-total').textContent = rupiah(price * quantity);
  const quantityInput = $('#transaction-quantity');
  quantityInput.max = part && $('#transaction-type').value === 'sale' ? part.stock : '';
}

async function refresh() {
  const [summary, parts, transactions] = await Promise.all([
    api('/api/summary'), api('/api/parts'), api('/api/transactions'),
  ]);
  state.parts = parts;
  state.transactions = transactions;
  renderSummary(summary);
  renderParts();
  renderTransactions();
}

function showView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  const titles = { overview: ['DASHBOARD / TOKO', 'Ringkasan'], inventory: ['KATALOG / SPAREPART', 'Inventaris'], transactions: ['BUKU BESAR / TRANSAKSI', 'Transaksi'] };
  $('#page-eyebrow').textContent = titles[view][0];
  $('#page-title').textContent = titles[view][1];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setToday() {
  $('#today-label').textContent = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
}

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-open-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.openView)));
$('#quick-transaction').addEventListener('click', () => showView('transactions'));
$('#part-search').addEventListener('input', renderParts);
$('#transaction-type').addEventListener('change', updateTransactionPrice);
$('#transaction-part').addEventListener('change', updateTransactionPrice);
$('#transaction-quantity').addEventListener('input', updateTransactionPrice);
$('#open-part-dialog').addEventListener('click', () => { $('#part-message').textContent = ''; $('#part-dialog').showModal(); });
$('.close-dialog').addEventListener('click', () => $('#part-dialog').close());
$('#part-dialog').addEventListener('click', (event) => { if (event.target === $('#part-dialog')) $('#part-dialog').close(); });

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-part]');
  if (!button) return;
  if (!window.confirm('Hapus sparepart ini? Item yang sudah memiliki riwayat transaksi tidak dapat dihapus.')) return;
  try {
    await api(`/api/parts/${button.dataset.deletePart}`, { method: 'DELETE' });
    await refresh();
    notify('Sparepart berhasil dihapus.');
  } catch (error) {
    notify(error.message);
  }
});

$('#part-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const partForm = event.currentTarget;
  const message = $('#part-message');
  message.textContent = '';
  const form = new FormData(partForm);
  const body = Object.fromEntries(form.entries());
  try {
    await api('/api/parts', { method: 'POST', body: JSON.stringify(body) });
    partForm.reset();
    $('#part-dialog').close();
    notify('Sparepart berhasil ditambahkan.');
    try {
      await refresh();
    } catch (error) {
      notify(`Sparepart tersimpan, tetapi tampilan belum diperbarui: ${error.message}`);
    }
  } catch (error) {
    message.textContent = error.message;
  }
});

$('#transaction-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#transaction-message');
  message.textContent = '';
  const type = $('#transaction-type').value;
  const part = state.parts.find((item) => item.id === $('#transaction-part').value);
  const quantity = Number($('#transaction-quantity').value);
  if (!part) { message.textContent = 'Pilih sparepart terlebih dahulu.'; return; }
  if (type === 'sale' && quantity > part.stock) { message.textContent = 'Jumlah melebihi stok yang tersedia.'; return; }
  try {
    await api('/api/transactions', {
      method: 'POST',
      body: JSON.stringify({ type, note: $('#transaction-note').value, items: [{ sparepart_id: part.id, quantity }] }),
    });
    $('#transaction-note').value = '';
    $('#transaction-quantity').value = '1';
    await refresh();
    notify(`${transactionLabel(type)} berhasil disimpan.`);
  } catch (error) {
    message.textContent = error.message;
  }
});

setToday();
refresh().catch((error) => {
  document.querySelectorAll('.empty-state').forEach((element) => element.classList.remove('hidden'));
  notify(`Gagal memuat data: ${error.message}`);
  console.error(error);
});
