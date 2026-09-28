const admin = {
  categories: [],
  products: [],
  statuses: [],
  editing: null,
  lastOrderId: null,
  view: 'orders',
};

// ---------- Sesión ----------

async function start() {
  const [{ user }, config] = await Promise.all([api('/api/auth/me'), api('/api/config')]);
  applyTheme(config.primaryColor);
  $('#logo').textContent = config.storeName;
  $('#mpStatus').textContent = config.mercadoPago
    ? '✅ Mercado Pago conectado: los clientes pueden pagar en línea.'
    : 'ℹ️ Pago en línea desactivado. Configura la variable MP_ACCESS_TOKEN en el servidor para activar Mercado Pago.';

  const isAdmin = user && user.role === 'admin';
  $('#loginBox').hidden = isAdmin;
  $('#panel').hidden = !isAdmin;
  $('#logoutBtn').hidden = !user;
  if (!isAdmin) {
    if (user) $('#loginError').textContent = 'Tu cuenta no tiene permisos de administrador.';
    return;
  }
  await loadCategories();
  showView(admin.view);
  setInterval(() => {
    loadStats();
    if (admin.view === 'orders') loadOrders(true);
  }, 20000);
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('/api/auth/login', { method: 'POST', body: { email: $('#email').value, password: $('#password').value } });
    start();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

$('#logoutBtn').onclick = async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
};

// ---------- Navegación ----------

function showView(view) {
  admin.view = view;
  $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('[data-section]').forEach((s) => { s.hidden = s.dataset.section !== view; });
  loadStats();
  ({ orders: loadOrders, products: loadProducts, categories: renderCategories, settings: loadSettings })[view]();
}

$$('[data-view]').forEach((b) => { b.onclick = () => showView(b.dataset.view); });

async function loadStats() {
  const s = await api('/api/admin/stats');
  $('#stats').innerHTML = `
    <div class="stat"><span class="muted">Pedidos hoy</span><b>${s.ordersToday}</b></div>
    <div class="stat"><span class="muted">Ventas hoy</span><b>${fmtMoney(s.salesToday)}</b></div>
    <div class="stat"><span class="muted">Pendientes</span><b>${s.pending}</b></div>
    <div class="stat"><span class="muted">Productos</span><b>${s.products}</b></div>
    <div class="stat"><span class="muted">Clientes</span><b>${s.customers}</b></div>`;
}

// ---------- Pedidos ----------

function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch { /* sin audio */ }
}

function orderCard(o) {
  const customerWa = o.customer.phone.replace(/\D/g, '');
  return `
    <div class="card admin-order">
      <div class="order-mini-head">
        <b>#${o.id} · ${esc(o.customer.name)}</b>
        <span class="status status-${o.status}">${STATUS_LABELS[o.status]}</span>
      </div>
      <p class="muted" style="margin:4px 0">${fmtDate(o.createdAt)}</p>
      <ul>${o.items.map((i) => `<li>${i.qty} × ${esc(i.name)}${i.note ? ` <i class="muted">(${esc(i.note)})</i>` : ''}</li>`).join('')}</ul>
      <p style="margin:4px 0"><b>Total ${fmtMoney(o.total)}</b> ${o.deliveryFee ? `<span class="muted">(incluye envío ${fmtMoney(o.deliveryFee)})</span>` : ''}</p>
      <p style="margin:4px 0">📞 ${esc(o.customer.phone)}</p>
      <p style="margin:4px 0">${o.delivery === 'envio' ? `🛵 ${esc(o.customer.address)}` : '🏪 Retira en el local'}</p>
      <p style="margin:4px 0">💳 ${PAYMENT_LABELS[o.payment]} ·
        <span class="status status-${o.paymentStatus === 'pagado' ? 'pagado' : 'pendiente'}">${o.paymentStatus === 'pagado' ? 'Pagado' : 'Sin pagar'}</span></p>
      ${o.notes ? `<p style="margin:4px 0">📝 ${esc(o.notes)}</p>` : ''}
      <div class="toolbar-row" style="margin:10px 0 0">
        <select data-status="${o.id}" aria-label="Cambiar estado">
          ${admin.statuses.map((s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
        </select>
        <button class="btn btn-ghost btn-sm" data-paid="${o.id}" data-value="${o.paymentStatus === 'pagado' ? 'pendiente' : 'pagado'}">
          ${o.paymentStatus === 'pagado' ? 'Marcar sin pagar' : 'Marcar pagado'}
        </button>
        ${customerWa ? `<a class="btn btn-wa btn-sm" target="_blank" rel="noopener" href="https://wa.me/${customerWa}?text=${encodeURIComponent(`Hola ${o.customer.name}, te escribimos por tu pedido #${o.id}.`)}">WhatsApp</a>` : ''}
        <a class="btn btn-ghost btn-sm" href="${esc(o.trackingUrl)}" target="_blank">Ver</a>
      </div>
    </div>`;
}

async function loadOrders(silent = false) {
  const status = $('#orderFilter').value;
  const { orders, statuses } = await api(`/api/admin/orders${status ? `?status=${status}` : ''}`);
  if (!admin.statuses.length) {
    admin.statuses = statuses;
    $('#orderFilter').innerHTML += statuses.map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join('');
  }
  const newest = orders[0]?.id ?? 0;
  if (silent && admin.lastOrderId !== null && newest > admin.lastOrderId) {
    toast('¡Nuevo pedido!');
    if ($('#soundToggle').checked) beep();
  }
  if (!status) admin.lastOrderId = Math.max(admin.lastOrderId ?? 0, newest);
  $('#orders').innerHTML = orders.length ? orders.map(orderCard).join('') : '<p class="empty">No hay pedidos.</p>';
}

$('#orderFilter').onchange = () => loadOrders();
$('#refreshOrders').onclick = () => { loadOrders(); loadStats(); };

$('#orders').addEventListener('change', async (e) => {
  const select = e.target.closest('[data-status]');
  if (!select) return;
  try {
    await api(`/api/admin/orders/${select.dataset.status}`, { method: 'PATCH', body: { status: select.value } });
    toast('Estado actualizado');
    loadOrders();
    loadStats();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#orders').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-paid]');
  if (!btn) return;
  await api(`/api/admin/orders/${btn.dataset.paid}`, { method: 'PATCH', body: { paymentStatus: btn.dataset.value } });
  loadOrders();
});

// ---------- Categorías ----------

async function loadCategories() {
  const { categories, products } = await api('/api/catalog');
  admin.categories = categories;
  if (!admin.products.length) admin.products = products;
  $('#pCat').innerHTML = categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

function categoryName(id) {
  return admin.categories.find((c) => c.id === id)?.name || '—';
}

async function renderCategories() {
  await loadCategories();
  admin.products = (await api('/api/admin/products')).products;
  $('#categoryRows').innerHTML = admin.categories.map((c) => `
    <tr>
      <td><input type="number" value="${c.order}" data-order="${c.id}" style="width:70px"></td>
      <td><input type="text" value="${esc(c.name)}" data-name="${c.id}" maxlength="60"></td>
      <td>${admin.products.filter((p) => p.categoryId === c.id).length}</td>
      <td><button class="btn btn-danger btn-sm" data-del-cat="${c.id}">Borrar</button></td>
    </tr>`).join('');
}

$('#categoryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/categories', { method: 'POST', body: { name: $('#categoryName').value } });
    $('#categoryName').value = '';
    renderCategories();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#categoryRows').addEventListener('change', async (e) => {
  const id = e.target.dataset.order || e.target.dataset.name;
  if (!id) return;
  const body = e.target.dataset.order ? { order: Number(e.target.value) } : { name: e.target.value };
  await api(`/api/admin/categories/${id}`, { method: 'PUT', body });
  toast('Categoría actualizada');
  loadCategories();
});

$('#categoryRows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del-cat]');
  if (!btn || !confirm('¿Borrar esta categoría?')) return;
  try {
    await api(`/api/admin/categories/${btn.dataset.delCat}`, { method: 'DELETE' });
    renderCategories();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- Productos ----------

async function loadProducts() {
  admin.products = (await api('/api/admin/products')).products;
  renderProducts();
}

function renderProducts() {
  const q = $('#productSearch').value.trim().toLowerCase();
  const rows = admin.products.filter((p) => !q || p.name.toLowerCase().includes(q));
  $('#productRows').innerHTML = rows.map((p) => `
    <tr>
      <td><img src="${esc(p.image || placeholderImage(p.name))}" alt=""></td>
      <td><b>${esc(p.name)}</b>${p.featured ? ' ⭐' : ''}<br><small class="muted">${esc(p.description)}</small></td>
      <td>${esc(categoryName(p.categoryId))}</td>
      <td>${fmtMoney(p.price)}</td>
      <td>${p.active ? '<span class="status status-entregado">Visible</span>' : '<span class="status">Oculto</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" data-edit="${p.id}">Editar</button>
        <button class="btn btn-danger btn-sm" data-del="${p.id}">Borrar</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">Sin productos</td></tr>';
}

$('#productSearch').oninput = renderProducts;

function setPreview(url) {
  $('#pPreview').hidden = !url;
  if (url) $('#pPreview').src = url;
}

function openProductEditor(product) {
  admin.editing = product;
  $('#productTitle').textContent = product ? 'Editar producto' : 'Nuevo producto';
  $('#pName').value = product?.name || '';
  $('#pDesc').value = product?.description || '';
  $('#pPrice').value = product?.price ?? '';
  $('#pCat').value = product?.categoryId || admin.categories[0]?.id || '';
  $('#pImage').value = product?.image || '';
  $('#pImageFile').value = '';
  $('#pActive').checked = product ? product.active : true;
  $('#pFeatured').checked = product ? product.featured : false;
  $('#productError').textContent = '';
  setPreview(product?.image);
  $('#productModal').hidden = false;
}

$('#newProduct').onclick = () => {
  if (!admin.categories.length) return toast('Primero crea una categoría', 'error');
  openProductEditor(null);
};

$('#productRows').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  const del = e.target.closest('[data-del]');
  if (edit) openProductEditor(admin.products.find((p) => p.id === Number(edit.dataset.edit)));
  if (del && confirm('¿Borrar este producto?')) {
    await api(`/api/admin/products/${del.dataset.del}`, { method: 'DELETE' });
    toast('Producto borrado');
    loadProducts();
  }
});

$('#productModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.closest('[data-close]')) e.currentTarget.hidden = true;
});

$('#pImage').oninput = () => setPreview($('#pImage').value.trim());

// Reduce la imagen en el navegador antes de subirla.
function resizeImage(file, maxSize = 1200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('No se pudo leer la imagen'));
    img.src = URL.createObjectURL(file);
  });
}

$('#pImageFile').onchange = async () => {
  const file = $('#pImageFile').files[0];
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file);
    const { url } = await api('/api/admin/upload', { method: 'POST', body: { dataUrl } });
    $('#pImage').value = url;
    setPreview(url);
  } catch (err) {
    $('#productError').textContent = err.message;
  }
};

$('#productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('#pName').value,
    description: $('#pDesc').value,
    price: Number($('#pPrice').value),
    categoryId: Number($('#pCat').value),
    image: $('#pImage').value.trim(),
    active: $('#pActive').checked,
    featured: $('#pFeatured').checked,
  };
  try {
    if (admin.editing) await api(`/api/admin/products/${admin.editing.id}`, { method: 'PUT', body });
    else await api('/api/admin/products', { method: 'POST', body });
    $('#productModal').hidden = true;
    toast('Producto guardado');
    loadProducts();
  } catch (err) {
    $('#productError').textContent = err.message;
  }
});

// ---------- Ajustes ----------

async function loadSettings() {
  const { settings } = await api('/api/admin/settings');
  const form = $('#settingsForm');
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements[key];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value ?? '';
  }
}

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {};
  for (const input of form.elements) {
    if (!input.name) continue;
    body[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  }
  try {
    const { settings } = await api('/api/admin/settings', { method: 'PUT', body });
    applyTheme(settings.primaryColor);
    $('#logo').textContent = settings.storeName;
    toast('Ajustes guardados');
  } catch (err) {
    toast(err.message, 'error');
  }
});

start().catch((err) => toast(err.message, 'error'));
