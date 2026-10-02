const SUPABASE_URL = 'https://nbpmdpejaxrxkgowmvmn.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_RXDP8Nb_wLdXLjFQhkDjnw_A7BNuD-o';
const USE_DIRECT_SUPABASE = location.hostname.endsWith('.github.io') || location.port === '5500';
const state = { parts: [], transactions: [], cart: [], view: 'overview' };
const $ = (selector) => document.querySelector(selector);
const rupiah = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value || 0));
const dateFormatter = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' });

async function supabaseRequest(path, options = {}) {
	const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
		...options,
		headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json', ...(options.headers || {}) },
	});
	const text = await response.text();
	let data = null;
	if (text) {
		try { data = JSON.parse(text); } catch { data = text; }
	}
	if (!response.ok) {
		const message = data?.code === '23505'
			? 'Kode sparepart sudah terdaftar. Gunakan kode lain.'
			: data?.message || data?.details || 'Permintaan database gagal.';
		throw Object.assign(new Error(message), { status: response.status });
	}
	return data;
}

async function directApi(path, options = {}) {
	const method = options.method || 'GET';
	const route = new URL(path, location.href).pathname;
	if (route === '/api/parts' && method === 'GET') return supabaseRequest('spareparts?select=*&order=name.asc');
	if (route === '/api/parts' && method === 'POST') {
		return (await supabaseRequest('spareparts', { method: 'POST', headers: { Prefer: 'return=representation' }, body: options.body }))[0];
	}
	if (route.startsWith('/api/parts/') && method === 'PATCH') {
		const id = route.slice('/api/parts/'.length);
		const rows = await supabaseRequest(`spareparts?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: options.body });
		if (!rows.length) throw new Error('Sparepart tidak ditemukan. Jalankan SQL terbaru di Supabase untuk mengaktifkan izin edit tanpa login.');
		return rows[0];
	}
	if (route.startsWith('/api/parts/') && method === 'DELETE') {
		const id = route.slice('/api/parts/'.length);
		await supabaseRequest(`spareparts?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
		return { ok: true };
	}
	if (route === '/api/transactions' && method === 'GET') {
		return supabaseRequest('transactions?select=*,transaction_items(quantity,unit_price,subtotal,spareparts(name,code))&order=transaction_date.desc&limit=100');
	}
	if (route === '/api/transactions' && method === 'POST') {
		const body = JSON.parse(options.body || '{}');
		return { id: await supabaseRequest('rpc/create_transaction', { method: 'POST', body: JSON.stringify({ p_type: body.type, p_note: body.note || '', p_items: body.items }) }) };
	}
	if (route === '/api/summary' && method === 'GET') {
		const [parts, transactions] = await Promise.all([
			supabaseRequest('spareparts?select=stock,purchase_price'),
			supabaseRequest('transactions?select=type,total,transaction_date&order=transaction_date.desc&limit=1000'),
		]);
		const sales = transactions.filter((item) => item.type === 'sale');
		return {
			part_count: parts.length,
			stock_units: parts.reduce((sum, item) => sum + item.stock, 0),
			stock_value: parts.reduce((sum, item) => sum + item.stock * Number(item.purchase_price), 0),
			sales_total: sales.reduce((sum, item) => sum + Number(item.total), 0),
			purchase_total: transactions.filter((item) => item.type === 'purchase').reduce((sum, item) => sum + Number(item.total), 0),
			transactions_today: transactions.filter((item) => item.transaction_date.slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
		};
	}
	throw new Error('Endpoint aplikasi tidak dikenal.');
}

async function api(path, options = {}) {
	if (USE_DIRECT_SUPABASE) return directApi(path, options);
	const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
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
	clearTimeout(notify.timeout);
	notify.timeout = setTimeout(() => toast.classList.remove('show'), 3200);
}

function transactionLabel(type) { return type === 'sale' ? 'Penjualan' : 'Pembelian stok'; }

function filteredTransactions() {
	const search = $('#history-search').value.trim().toLocaleLowerCase('id-ID');
	const type = $('#history-type').value;
	const month = $('#history-month').value;
	return state.transactions.filter((transaction) => {
		if (type !== 'all' && transaction.type !== type) return false;
		if (month && transaction.transaction_date.slice(0, 7) !== month) return false;
		const itemText = (transaction.transaction_items || []).map((item) => `${item.spareparts?.name || ''} ${item.spareparts?.code || ''}`).join(' ');
		return !search || `${transaction.note || ''} ${itemText}`.toLocaleLowerCase('id-ID').includes(search);
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
	const search = $('#part-search').value.toLocaleLowerCase('id-ID');
	const matching = state.parts.filter((part) => `${part.code} ${part.name} ${part.category}`.toLocaleLowerCase('id-ID').includes(search));
	$('#inventory-count').textContent = `${matching.length} item`;
	$('#inventory-parts').innerHTML = matching.map((part) => `<tr>
		<td><span class="part-code">${escapeHtml(part.code)}</span></td><td><strong>${escapeHtml(part.name)}</strong></td><td>${escapeHtml(part.category)}</td>
		<td><span class="stock-badge ${part.stock <= 3 ? 'low' : ''}">${Number(part.stock).toLocaleString('id-ID')} unit</span></td>
		<td>${rupiah(part.purchase_price)}</td><td>${rupiah(part.selling_price)}</td>
		<td class="part-actions"><button class="row-action edit-action" data-edit-part="${escapeHtml(part.id)}" aria-label="Edit ${escapeHtml(part.name)}" title="Edit">✎</button><button class="row-action" data-delete-part="${escapeHtml(part.id)}" aria-label="Hapus ${escapeHtml(part.name)}" title="Hapus">×</button></td>
	</tr>`).join('');
	$('#inventory-empty').classList.toggle('hidden', matching.length > 0);
	const overview = state.parts.slice(0, 6);
	$('#overview-parts').innerHTML = overview.map((part) => `<tr><td><strong>${escapeHtml(part.name)}</strong><span class="part-code">${escapeHtml(part.code)}</span></td><td>${escapeHtml(part.category)}</td><td><span class="stock-badge ${part.stock <= 3 ? 'low' : ''}">${Number(part.stock).toLocaleString('id-ID')}</span></td><td>${rupiah(part.selling_price)}</td></tr>`).join('');
	$('#overview-empty').classList.toggle('hidden', overview.length > 0);
	const selected = $('#transaction-part').value;
	$('#transaction-part').innerHTML = '<option value="">Pilih sparepart...</option>' + state.parts.map((part) => `<option value="${escapeHtml(part.id)}">${escapeHtml(part.code)} · ${escapeHtml(part.name)} (${Number(part.stock)} tersedia)</option>`).join('');
	if (state.parts.some((part) => part.id === selected)) $('#transaction-part').value = selected;
	updateTransactionPrice();
}

function renderCart() {
	const type = $('#transaction-type').value;
	const items = state.cart.map((entry) => {
		const part = state.parts.find((candidate) => candidate.id === entry.sparepart_id);
		if (!part) return null;
		const unitPrice = Number(type === 'sale' ? part.selling_price : part.purchase_price);
		return { ...entry, part, unitPrice, subtotal: unitPrice * entry.quantity };
	}).filter(Boolean);
	$('#cart-count').textContent = `${items.length} item`;
	$('#transaction-cart').innerHTML = items.length ? items.map((item) => `<div class="cart-row"><div class="cart-item-copy"><strong>${escapeHtml(item.part.name)}</strong><small>${escapeHtml(item.part.code)} · ${rupiah(item.unitPrice)} × ${item.quantity}</small></div><strong class="cart-subtotal">${rupiah(item.subtotal)}</strong><button type="button" class="cart-remove" data-remove-cart="${escapeHtml(item.sparepart_id)}" aria-label="Hapus dari transaksi">×</button></div>`).join('') : '<p class="cart-empty">Pilih sparepart lalu tambahkan ke transaksi.</p>';
	$('#transaction-total').textContent = rupiah(items.reduce((total, item) => total + item.subtotal, 0));
}

function updateTransactionPrice() {
	const part = state.parts.find((item) => item.id === $('#transaction-part').value);
	const type = $('#transaction-type').value;
	$('#unit-price').textContent = part ? rupiah(type === 'sale' ? part.selling_price : part.purchase_price) : rupiah(0);
	$('#transaction-quantity').max = part && type === 'sale' ? part.stock : '';
	renderCart();
}

function renderTransactions() {
	const recent = state.transactions.slice(0, 5);
	$('#recent-transactions').innerHTML = recent.map((transaction) => `<div class="recent-item"><span class="recent-icon ${transaction.type}">${transaction.type === 'sale' ? '↗' : '↙'}</span><div class="recent-copy"><strong>${transactionLabel(transaction.type)}</strong><small>${dateFormatter.format(new Date(transaction.transaction_date))} · ${transaction.transaction_items?.length || 0} item</small></div><div class="recent-amount">${rupiah(transaction.total)}<small>${timeFormatter.format(new Date(transaction.transaction_date))}</small></div></div>`).join('');
	$('#transactions-empty').classList.toggle('hidden', recent.length > 0);
	const transactions = filteredTransactions();
	$('#history-result-count').textContent = `${transactions.length} dari ${state.transactions.length} transaksi`;
	$('#transaction-history').innerHTML = transactions.map((transaction) => {
		const descriptions = (transaction.transaction_items || []).map((item) => `${item.spareparts?.code || ''} ${item.spareparts?.name || 'Sparepart'} × ${item.quantity}`).join(', ');
		return `<article class="history-entry"><span class="history-icon ${transaction.type}">${transaction.type === 'sale' ? '↗' : '↙'}</span><div class="history-description"><strong>${transactionLabel(transaction.type)}${transaction.note ? ` · ${escapeHtml(transaction.note)}` : ''}</strong><small>${dateFormatter.format(new Date(transaction.transaction_date))} · ${escapeHtml(descriptions)}</small></div><div class="history-total">${rupiah(transaction.total)}<small>${timeFormatter.format(new Date(transaction.transaction_date))}</small></div></article>`;
	}).join('');
	$('#history-empty').classList.toggle('hidden', transactions.length > 0);
}

function exportTransactions() {
	const transactions = filteredTransactions();
	if (!transactions.length) return notify('Tidak ada transaksi untuk diekspor.');
	const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
	const rows = [['Tanggal', 'Waktu', 'Jenis', 'Kode sparepart', 'Nama sparepart', 'Jumlah', 'Harga satuan', 'Subtotal item', 'Total transaksi', 'Catatan']];
	transactions.forEach((transaction) => (transaction.transaction_items || []).forEach((item) => rows.push([
		dateFormatter.format(new Date(transaction.transaction_date)), timeFormatter.format(new Date(transaction.transaction_date)), transactionLabel(transaction.type),
		item.spareparts?.code || '', item.spareparts?.name || '', item.quantity, item.unit_price, item.subtotal, transaction.total, transaction.note || '',
	])));
	const blob = new Blob([`\uFEFF${rows.map((row) => row.map(quote).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = `riwayat-transaksi-${new Date().toISOString().slice(0, 10)}.csv`;
	link.click();
	URL.revokeObjectURL(url);
}

async function refresh() {
	const [summary, parts, transactions] = await Promise.all([api('/api/summary'), api('/api/parts'), api('/api/transactions')]);
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
}

function openPartDialog(part = null) {
	const form = $('#part-form');
	form.reset();
	$('#part-message').textContent = '';
	if (part) {
		form.dataset.editId = part.id;
		form.elements.code.value = part.code;
		form.elements.name.value = part.name;
		form.elements.category.value = part.category;
		form.elements.stock.value = part.stock;
		form.elements.stock.readOnly = true;
		$('#stock-field-label').firstChild.textContent = 'STOK SAAT INI';
		$('#part-dialog-title').textContent = 'Edit sparepart';
		$('#part-submit').innerHTML = 'Simpan perubahan <span>→</span>';
	} else {
		delete form.dataset.editId;
		form.elements.stock.readOnly = false;
		$('#stock-field-label').firstChild.textContent = 'STOK AWAL';
		$('#part-dialog-title').textContent = 'Tambah sparepart';
		$('#part-submit').innerHTML = 'Simpan sparepart <span>→</span>';
	}
	$('#part-dialog').showModal();
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
	if (!part) return void (message.textContent = 'Pilih sparepart terlebih dahulu.');
	if (!Number.isInteger(quantity) || quantity < 1) return void (message.textContent = 'Jumlah harus bilangan bulat minimal 1.');
	const existing = state.cart.find((item) => item.sparepart_id === part.id);
	const nextQuantity = quantity + (existing?.quantity || 0);
	if ($('#transaction-type').value === 'sale' && nextQuantity > part.stock) return void (message.textContent = `Stok ${part.name} hanya ${part.stock} unit.`);
	if (existing) existing.quantity = nextQuantity;
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
$('#open-part-dialog').addEventListener('click', () => openPartDialog());
$('.close-dialog').addEventListener('click', () => $('#part-dialog').close());
$('#part-dialog').addEventListener('click', (event) => { if (event.target === $('#part-dialog')) $('#part-dialog').close(); });

document.addEventListener('click', async (event) => {
	const edit = event.target.closest('[data-edit-part]');
	if (edit) return openPartDialog(state.parts.find((part) => part.id === edit.dataset.editPart));
	const remove = event.target.closest('[data-delete-part]');
	if (!remove || !confirm('Hapus sparepart ini? Item yang memiliki riwayat transaksi tidak dapat dihapus.')) return;
	try { await api(`/api/parts/${remove.dataset.deletePart}`, { method: 'DELETE' }); await refresh(); notify('Sparepart berhasil dihapus.'); }
	catch (error) { notify(error.message); }
});

$('#part-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	const message = $('#part-message');
	message.textContent = '';
	const body = Object.fromEntries(new FormData(form).entries());
	const editId = form.dataset.editId;
	const editing = Boolean(editId);
	if (editing) delete body.stock;
	try {
		await api(editing ? `/api/parts/${editId}` : '/api/parts', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
		delete form.dataset.editId;
		form.reset();
		$('#part-dialog').close();
		notify(editing ? 'Perubahan sparepart tersimpan.' : 'Sparepart berhasil ditambahkan.');
		await refresh();
	} catch (error) { message.textContent = error.message; }
});

$('#transaction-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const message = $('#transaction-message');
	message.textContent = '';
	const type = $('#transaction-type').value;
	if (!state.cart.length) return void (message.textContent = 'Tambahkan minimal satu sparepart ke transaksi.');
	if (type === 'sale' && state.cart.some((item) => item.quantity > (state.parts.find((part) => part.id === item.sparepart_id)?.stock ?? -1))) return void (message.textContent = 'Jumlah di keranjang melebihi stok terbaru.');
	try {
		await api('/api/transactions', { method: 'POST', body: JSON.stringify({ type, note: $('#transaction-note').value, items: state.cart }) });
		state.cart = [];
		$('#transaction-note').value = '';
		$('#transaction-quantity').value = '1';
		renderCart();
		notify(`${transactionLabel(type)} berhasil disimpan.`);
		await refresh();
	} catch (error) { message.textContent = error.message; }
});

$('#today-label').textContent = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
refresh().catch((error) => { notify(`Gagal memuat data: ${error.message}`); console.error(error); });
