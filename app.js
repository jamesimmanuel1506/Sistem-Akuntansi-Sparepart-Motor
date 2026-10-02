const rupiah = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value || 0));
const dateFormatter = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' });
const state = { parts: [], transactions: [], cart: [], view: 'overview' };
const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
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

function filteredTransactions() {
  const searchTerm = $('#history-search').value.trim().toLocaleLowerCase('id-ID');
  const selectedType = $('#history-type').value;
  const selectedMonth = $('#history-month').value;
  return state.transactions.filter((transaction) => {
    if (selectedType !== 'all' && transaction.type !== selectedType) return false;
    if (selectedMonth && transaction.transaction_date.slice(0, 7) !== selectedMonth) return false;
    if (!searchTerm) return true;
    const itemsText = (transaction.transaction_items || []).map((item) => `${item.spareparts?.name || ''} ${item.spareparts?.code || ''}`).join(' ');
    return `${transaction.note} ${itemsText}`.toLocaleLowerCase('id-ID').includes(searchTerm);
  });
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
    <td class="part-actions"><button class="row-action edit-action" data-edit-part="${escapeHtml(part.id)}" title="Edit sparepart" aria-label="Edit ${escapeHtml(part.name)}">✎</button><button class="row-action" data-delete-part="${escapeHtml(part.id)}" title="Hapus sparepart" aria-label="Hapus ${escapeHtml(part.name)}">×</button></td>
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
  const visibleTransactions = filteredTransactions();
  $('#history-result-count').textContent = `${visibleTransactions.length} dari ${state.transactions.length} transaksi`;
  $('#transaction-history').innerHTML = visibleTransactions.map((transaction) => {
    const items = (transaction.transaction_items || []).map((item) => `${item.spareparts?.name || 'Sparepart'} × ${item.quantity}`).join(', ');
    return `<article class="history-entry">
      <span class="history-icon ${transaction.type}">${transaction.type === 'sale' ? '↗' : '↙'}</span>
      <div class="history-description"><strong>${transactionLabel(transaction.type)}${transaction.note ? ` · ${escapeHtml(transaction.note)}` : ''}</strong><small>${dateFormatter.format(new Date(transaction.transaction_date))} · ${escapeHtml(items)}</small></div>
      <div class="history-total">${rupiah(transaction.total)}<small>${timeFormatter.format(new Date(transaction.transaction_date))}</small></div>
    </article>`;
  }).join('');
  $('#history-empty').classList.toggle('hidden', visibleTransactions.length > 0);
}

function exportTransactions() {
  const transactions = filteredTransactions();
  const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [['Tanggal', 'Waktu', 'Jenis', 'Kode sparepart', 'Nama sparepart', 'Jumlah', 'Harga satuan', 'Subtotal item', 'Total transaksi', 'Catatan']];
  transactions.forEach((transaction) => {
    (transaction.transaction_items || []).forEach((item) => rows.push([
      dateFormatter.format(new Date(transaction.transaction_date)),
      timeFormatter.format(new Date(transaction.transaction_date)),
      transactionLabel(transaction.type),
      item.spareparts?.code || '',
      item.spareparts?.name || '',
      item.quantity,
      item.unit_price,
      item.subtotal,
      transaction.total,
      transaction.note || '',
    ]));
  });
  if (!transactions.length) {
    notify('Tidak ada transaksi untuk diekspor.');
    return;
  }
  const csv = `\uFEFF${rows.map((row) => row.map(quote).join(',')).join('\r\n')}`;
  const downloadUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = `riwayat-transaksi-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(downloadUrl);
  notify(`CSV ${transactions.length} transaksi diunduh.`);
}

function updateTransactionPrice() {
  const part = state.parts.find((item) => item.id === $('#transaction-part').value);
  const price = part ? Number($('#transaction-type').value === 'sale' ? part.selling_price : part.purchase_price) : 0;
  $('#unit-price').textContent = rupiah(price);
  const quantityInput = $('#transaction-quantity');
  quantityInput.max = part && $('#transaction-type').value === 'sale' ? part.stock : '';
  renderCart();
}

function renderCart() {
  const type = $('#transaction-type').value;
  const cart = state.cart.map((item) => {
    const part = state.parts.find((entry) => entry.id === item.sparepart_id);
    if (!part) return null;
    const unitPrice = Number(type === 'sale' ? part.selling_price : part.purchase_price);
    return { ...item, part, unitPrice, subtotal: unitPrice * item.quantity };
  }).filter(Boolean);

  $('#cart-count').textContent = `${cart.length} item`;
  $('#transaction-cart').innerHTML = cart.length ? cart.map((item) => `<div class="cart-row">
    <div class="cart-item-copy"><strong>${escapeHtml(item.part.name)}</strong><small>${escapeHtml(item.part.code)} · ${rupiah(item.unitPrice)} × ${item.quantity}</small></div>
    <strong class="cart-subtotal">${rupiah(item.subtotal)}</strong>
    <button class="cart-remove" type="button" data-remove-cart="${escapeHtml(item.sparepart_id)}" aria-label="Hapus ${escapeHtml(item.part.name)} dari transaksi">×</button>
  </div>`).join('') : '<p class="cart-empty">Pilih sparepart lalu tambahkan ke transaksi.</p>';
  $('#transaction-total').textContent = rupiah(cart.reduce((sum, item) => sum + item.subtotal, 0));
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
$('#add-cart-item').addEventListener('click', () => {
  const message = $('#transaction-message');
  message.textContent = '';
  const part = state.parts.find((item) => item.id === $('#transaction-part').value);
  const quantity = Number($('#transaction-quantity').value);
  if (!part) { message.textContent = 'Pilih sparepart terlebih dahulu.'; return; }
  if (!Number.isInteger(quantity) || quantity < 1) { message.textContent = 'Jumlah harus berupa bilangan bulat minimal 1.'; return; }

  const existingItem = state.cart.find((item) => item.sparepart_id === part.id);
  const nextQuantity = quantity + (existingItem?.quantity || 0);
  if ($('#transaction-type').value === 'sale' && nextQuantity > part.stock) {
    message.textContent = `Stok ${part.name} hanya ${part.stock} unit.`;
    return;
  }

  if (existingItem) existingItem.quantity = nextQuantity;
  else state.cart.push({ sparepart_id: part.id, quantity });
  $('#transaction-quantity').value = '1';
  renderCart();
});
$('#transaction-cart').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-cart]');
  if (!button) return;
  state.cart = state.cart.filter((item) => item.sparepart_id !== button.dataset.removeCart);
  renderCart();
});
$('#history-search').addEventListener('input', renderTransactions);
$('#history-type').addEventListener('change', renderTransactions);
$('#history-month').addEventListener('change', renderTransactions);
$('#export-transactions').addEventListener('click', exportTransactions);
$('#open-part-dialog').addEventListener('click', () => {
  const form = $('#part-form');
  form.reset();
  delete form.dataset.editId;
  form.elements.stock.readOnly = false;
  $('#stock-field-label').firstChild.textContent = 'STOK AWAL';
  $('#part-dialog-title').textContent = 'Tambah sparepart';
  $('#part-submit').firstChild.textContent = 'Simpan sparepart ';
  $('#part-message').textContent = '';
  $('#part-dialog').showModal();
});
$('.close-dialog').addEventListener('click', () => $('#part-dialog').close());
$('#part-dialog').addEventListener('click', (event) => { if (event.target === $('#part-dialog')) $('#part-dialog').close(); });

document.addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit-part]');
  if (editButton) {
    const part = state.parts.find((item) => item.id === editButton.dataset.editPart);
    if (!part) return;
    const form = $('#part-form');
    form.dataset.editId = part.id;
    form.elements.code.value = part.code;
    form.elements.name.value = part.name;
    form.elements.category.value = part.category;
    form.elements.stock.value = part.stock;
    form.elements.stock.readOnly = true;
    form.elements.purchase_price.value = part.purchase_price;
    form.elements.selling_price.value = part.selling_price;
    $('#stock-field-label').firstChild.textContent = 'STOK SAAT INI';
    $('#part-dialog-title').textContent = 'Edit sparepart';
    $('#part-submit').firstChild.textContent = 'Simpan perubahan ';
    $('#part-message').textContent = '';
    $('#part-dialog').showModal();
    return;
  }
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
  const editId = partForm.dataset.editId;
  try {
    const isEditing = Boolean(editId);
    if (isEditing) delete body.stock;
    await api(isEditing ? `/api/parts/${editId}` : '/api/parts', {
      method: isEditing ? 'PATCH' : 'POST',
      body: JSON.stringify(body),
    });
    delete partForm.dataset.editId;
    partForm.reset();
    $('#part-dialog').close();
    notify(isEditing ? 'Perubahan sparepart berhasil disimpan.' : 'Sparepart berhasil ditambahkan.');
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
  if (!state.cart.length) { message.textContent = 'Tambahkan minimal satu sparepart ke transaksi.'; return; }
  if (type === 'sale') {
    const unavailableItem = state.cart.find((item) => {
      const part = state.parts.find((entry) => entry.id === item.sparepart_id);
      return !part || item.quantity > part.stock;
    });
    if (unavailableItem) { message.textContent = 'Jumlah di keranjang melebihi stok terbaru.'; return; }
  }
  try {
    await api('/api/transactions', {
      method: 'POST',
      body: JSON.stringify({ type, note: $('#transaction-note').value, items: state.cart.map(({ sparepart_id, quantity }) => ({ sparepart_id, quantity })) }),
    });
    state.cart = [];
    $('#transaction-note').value = '';
    $('#transaction-quantity').value = '1';
    renderCart();
    notify(`${transactionLabel(type)} berhasil disimpan.`);
    try {
      await refresh();
    } catch (error) {
      notify(`Transaksi tersimpan, tetapi tampilan belum diperbarui: ${error.message}`);
    }
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
