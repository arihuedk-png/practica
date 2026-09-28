const state = {
  config: {},
  categories: [],
  products: [],
  filter: 'all',
  search: '',
  user: null,
  cart: loadCart(),
  current: null, // producto abierto en el modal
  qty: 1,
};

// ---------- Carrito (se guarda en el navegador) ----------

function loadCart() {
  try {
    return JSON.parse(localStorage.getItem('cart')) || [];
  } catch {
    return [];
  }
}

function saveCart() {
  try {
    localStorage.setItem('cart', JSON.stringify(state.cart));
  } catch { /* almacenamiento no disponible */ }
  renderCart();
}

function productById(id) {
  return state.products.find((p) => p.id === id);
}

function cartLines() {
  // Descarta productos que ya no existen en el catálogo.
  return state.cart.map((line) => ({ ...line, product: productById(line.productId) })).filter((l) => l.product);
}

function cartSubtotal() {
  return cartLines().reduce((sum, l) => sum + l.product.price * l.qty, 0);
}

function addToCart(productId, qty, note) {
  const existing = state.cart.find((l) => l.productId === productId && l.note === note);
  if (existing) existing.qty = Math.min(99, existing.qty + qty);
  else state.cart.push({ productId, qty, note });
  saveCart();
}

// ---------- Modales ----------

function openModal(el) {
  el.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal(el) {
  el.hidden = true;
  if ($$('.overlay').every((o) => o.hidden)) document.body.style.overflow = '';
}

$$('.overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-close]')) closeModal(overlay);
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.overlay').filter((o) => !o.hidden).forEach(closeModal);
});

// ---------- Catálogo ----------

function productCard(p) {
  return `
    <article class="product" data-id="${p.id}">
      <img src="${esc(p.image || placeholderImage(p.name))}" alt="${esc(p.name)}" loading="lazy">
      <div class="product-body">
        <h3 class="product-name">${esc(p.name)}</h3>
        <p class="product-desc">${esc(p.description)}</p>
        <div class="product-foot">
          <span class="price">${fmtMoney(p.price)}</span>
          <button class="btn add-btn" data-quick="${p.id}" aria-label="Agregar ${esc(p.name)}">+</button>
        </div>
      </div>
    </article>`;
}

function renderChips() {
  const chips = [{ id: 'all', name: 'Todo' }, ...state.categories];
  $('#chips').innerHTML = chips
    .map((c) => `<button class="chip ${String(state.filter) === String(c.id) ? 'active' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`)
    .join('');
}

function renderCatalog() {
  const q = state.search.toLowerCase();
  const visible = state.products.filter((p) =>
    (state.filter === 'all' || p.categoryId === Number(state.filter))
    && (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)));

  let html = '';
  if (state.filter === 'all' && !q) {
    const featured = visible.filter((p) => p.featured);
    if (featured.length) html += `<h2 class="section-title">⭐ Destacados</h2><div class="grid">${featured.map(productCard).join('')}</div>`;
  }
  for (const cat of state.categories) {
    const items = visible.filter((p) => p.categoryId === cat.id);
    if (items.length) html += `<h2 class="section-title">${esc(cat.name)}</h2><div class="grid">${items.map(productCard).join('')}</div>`;
  }
  $('#catalog').innerHTML = html || '<p class="empty">No encontramos productos.</p>';
}

$('#chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-cat]');
  if (!chip) return;
  state.filter = chip.dataset.cat;
  renderChips();
  renderCatalog();
});

$('#search').addEventListener('input', (e) => {
  state.search = e.target.value.trim();
  renderCatalog();
});

$('#catalog').addEventListener('click', (e) => {
  const quick = e.target.closest('[data-quick]');
  if (quick) {
    e.stopPropagation();
    if (!state.config.isOpen) return toast('La tienda está cerrada en este momento', 'error');
    addToCart(Number(quick.dataset.quick), 1, '');
    toast('Agregado al carrito');
    return;
  }
  const card = e.target.closest('.product');
  if (card) openProduct(Number(card.dataset.id));
});

// ---------- Detalle de producto ----------

function openProduct(id) {
  const p = productById(id);
  if (!p) return;
  state.current = p;
  state.qty = 1;
  $('#pmImg').src = p.image || placeholderImage(p.name);
  $('#pmImg').alt = p.name;
  $('#pmName').textContent = p.name;
  $('#pmDesc').textContent = p.description;
  $('#pmNote').value = '';
  updateProductModal();
  openModal($('#productModal'));
}

function updateProductModal() {
  $('#pmQty').textContent = state.qty;
  $('#pmPrice').textContent = fmtMoney(state.current.price);
  $('#pmAdd').textContent = `Agregar ${fmtMoney(state.current.price * state.qty)}`;
  $('#pmAdd').disabled = !state.config.isOpen;
}

$('#pmMinus').onclick = () => { state.qty = Math.max(1, state.qty - 1); updateProductModal(); };
$('#pmPlus').onclick = () => { state.qty = Math.min(99, state.qty + 1); updateProductModal(); };
$('#pmAdd').onclick = () => {
  addToCart(state.current.id, state.qty, $('#pmNote').value.trim());
  closeModal($('#productModal'));
  toast('Agregado al carrito');
};

// ---------- Carrito ----------

function totalsHtml(delivery) {
  const subtotal = cartSubtotal();
  const fee = delivery === 'envio' ? Number(state.config.deliveryFee || 0) : 0;
  return `
    <div><span>Subtotal</span><span>${fmtMoney(subtotal)}</span></div>
    ${delivery !== undefined ? `<div><span>Envío</span><span>${fee ? fmtMoney(fee) : 'Gratis'}</span></div>` : ''}
    <div class="total"><span>Total</span><span>${fmtMoney(subtotal + fee)}</span></div>`;
}

function renderCart() {
  const lines = cartLines();
  const count = lines.reduce((n, l) => n + l.qty, 0);
  $('#cartCount').textContent = count;
  $('#cartCount').hidden = !count;
  $('#floatCount').textContent = count;
  $('#floatTotal').textContent = fmtMoney(cartSubtotal());
  $('#floatCart').hidden = !count;

  $('#cartItems').innerHTML = lines.length
    ? lines.map((l, i) => `
      <div class="cart-item">
        <img src="${esc(l.product.image || placeholderImage(l.product.name))}" alt="">
        <div class="cart-item-info">
          <p><b>${esc(l.product.name)}</b></p>
          ${l.note ? `<p class="cart-item-note">${esc(l.note)}</p>` : ''}
          <div class="cart-item-actions">
            <div class="qty"><button data-dec="${i}" aria-label="Menos">−</button><span>${l.qty}</span><button data-inc="${i}" aria-label="Más">+</button></div>
            <b>${fmtMoney(l.product.price * l.qty)}</b>
          </div>
        </div>
      </div>`).join('')
    : '<p class="empty">Tu carrito está vacío.</p>';

  $('#cartTotals').innerHTML = totalsHtml();
  const min = Number(state.config.minOrder || 0);
  const belowMin = min && cartSubtotal() < min;
  $('#checkoutBtn').disabled = !lines.length || !state.config.isOpen || belowMin;
  $('#checkoutBtn').textContent = !state.config.isOpen
    ? 'Tienda cerrada'
    : belowMin ? `Pedido mínimo ${fmtMoney(min)}` : 'Continuar';
}

$('#cartItems').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-inc], [data-dec]');
  if (!btn) return;
  const line = cartLines()[Number(btn.dataset.inc ?? btn.dataset.dec)];
  const stored = line && state.cart.find((l) => l.productId === line.productId && l.note === line.note);
  if (!stored) return;
  stored.qty = Math.min(99, stored.qty + (btn.dataset.inc !== undefined ? 1 : -1));
  if (stored.qty <= 0) state.cart.splice(state.cart.indexOf(stored), 1);
  saveCart();
});

$('#cartBtn').onclick = () => openModal($('#cartDrawer'));
$('#floatCart').onclick = () => openModal($('#cartDrawer'));

// ---------- Finalizar pedido ----------

function selectedDelivery() {
  return $('input[name=delivery]:checked').value;
}

function updateCheckout() {
  const delivery = selectedDelivery();
  $('#addressBox').hidden = delivery !== 'envio';
  $('#coAddress').required = delivery === 'envio';
  $('#coTotals').innerHTML = totalsHtml(delivery);
  const payment = $('input[name=payment]:checked').value;
  $('#transferInfo').hidden = payment !== 'transferencia' || !state.config.transferInfo;
  $('#coSubmit').textContent = payment === 'mercadopago' ? 'Confirmar e ir a pagar' : 'Confirmar pedido';
}

$('#checkoutForm').addEventListener('change', updateCheckout);

$('#checkoutBtn').onclick = () => {
  if (state.user) {
    $('#coName').value ||= state.user.name;
    $('#coPhone').value ||= state.user.phone || '';
  }
  $('#coError').textContent = '';
  closeModal($('#cartDrawer'));
  updateCheckout();
  openModal($('#checkoutModal'));
};

$('#checkoutForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('#coSubmit');
  button.disabled = true;
  $('#coError').textContent = '';
  try {
    const { order, paymentUrl } = await api('/api/orders', {
      method: 'POST',
      body: {
        items: state.cart.map(({ productId, qty, note }) => ({ productId, qty, note })),
        customer: { name: $('#coName').value, phone: $('#coPhone').value, address: $('#coAddress').value },
        delivery: selectedDelivery(),
        payment: $('input[name=payment]:checked').value,
        notes: $('#coNotes').value,
      },
    });
    state.cart = [];
    saveCart();
    $('#checkoutForm').reset();
    closeModal($('#checkoutModal'));
    showDone(order, paymentUrl);
  } catch (err) {
    $('#coError').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

function showDone(order, paymentUrl) {
  $('#doneTitle').textContent = `¡Pedido #${order.id} recibido!`;
  $('#doneText').textContent = order.whatsappUrl
    ? 'Envíanos el pedido por WhatsApp para confirmarlo más rápido.'
    : 'Te avisaremos cuando esté confirmado.';
  $('#doneWa').hidden = !order.whatsappUrl;
  if (order.whatsappUrl) $('#doneWa').href = order.whatsappUrl;
  $('#donePay').hidden = !paymentUrl;
  if (paymentUrl) $('#donePay').href = paymentUrl;
  $('#doneTrack').href = order.trackingUrl;
  openModal($('#doneModal'));
  if (paymentUrl) window.location.href = paymentUrl;
}

// ---------- Cuenta ----------

function renderAccount() {
  $('#authBox').hidden = Boolean(state.user);
  $('#profileBox').hidden = !state.user;
  $('#accountTitle').textContent = state.user ? 'Mi cuenta' : 'Ingresar';
  if (state.user) {
    $('#profileName').textContent = state.user.name;
    $('#adminLink').hidden = state.user.role !== 'admin';
  }
}

async function loadMyOrders() {
  const box = $('#myOrders');
  box.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    const { orders } = await api('/api/orders/mine');
    box.innerHTML = orders.length
      ? orders.map((o) => `
        <div class="order-mini">
          <div class="order-mini-head">
            <b>#${o.id}</b>
            <span class="status status-${o.status}">${STATUS_LABELS[o.status]}</span>
          </div>
          <p class="muted" style="margin:4px 0">${fmtDate(o.createdAt)} · ${fmtMoney(o.total)}</p>
          <a href="${esc(o.trackingUrl)}">Ver detalle</a>
        </div>`).join('')
      : '<p class="muted">Todavía no tienes pedidos.</p>';
  } catch (err) {
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

$('#userBtn').onclick = () => {
  renderAccount();
  if (state.user) loadMyOrders();
  openModal($('#accountModal'));
};

$$('[data-tab]').forEach((tab) => {
  tab.onclick = () => {
    const login = tab.dataset.tab === 'login';
    $('#loginForm').hidden = !login;
    $('#registerForm').hidden = login;
    $$('[data-tab]').forEach((t) => t.classList.toggle('btn-ghost', t !== tab));
  };
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#liError').textContent = '';
  try {
    const { user } = await api('/api/auth/login', { method: 'POST', body: { email: $('#liEmail').value, password: $('#liPass').value } });
    state.user = user;
    e.target.reset();
    renderAccount();
    loadMyOrders();
    toast(`¡Hola, ${user.name}!`);
  } catch (err) {
    $('#liError').textContent = err.message;
  }
});

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#reError').textContent = '';
  try {
    const { user } = await api('/api/auth/register', {
      method: 'POST',
      body: { name: $('#reName').value, email: $('#reEmail').value, phone: $('#rePhone').value, password: $('#rePass').value },
    });
    state.user = user;
    e.target.reset();
    renderAccount();
    loadMyOrders();
    toast('Cuenta creada');
  } catch (err) {
    $('#reError').textContent = err.message;
  }
});

$('#logoutBtn').onclick = async () => {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  renderAccount();
  toast('Sesión cerrada');
};

// ---------- Inicio ----------

function renderHeader() {
  const c = state.config;
  applyTheme(c.primaryColor);
  document.title = c.storeName;
  $('#logo').textContent = c.storeName;
  $('#storeName').textContent = c.storeName;
  $('#tagline').textContent = c.tagline || '';
  $('#openPill').textContent = c.isOpen ? 'Abierto ahora' : 'Cerrado';
  $('#openPill').className = `pill ${c.isOpen ? 'pill-open' : 'pill-closed'}`;
  $('#hoursPill').hidden = !c.hours;
  $('#hoursPill').textContent = `🕒 ${c.hours}`;
  $('#deliveryPill').hidden = false;
  $('#deliveryPill').textContent = c.deliveryFee ? `🛵 Envío ${fmtMoney(c.deliveryFee)}` : '🛵 Envío gratis';
  $('#coFeeLabel').textContent = c.deliveryFee ? `(+${fmtMoney(c.deliveryFee)})` : '(gratis)';
  $('#mpOption').hidden = !c.mercadoPago;
  $('#transferInfo').textContent = c.transferInfo || '';
  $('#footer').textContent = [c.storeName, c.address, c.whatsapp && `WhatsApp: ${c.whatsapp}`].filter(Boolean).join(' · ');
}

async function init() {
  try {
    const [config, catalog, me] = await Promise.all([api('/api/config'), api('/api/catalog'), api('/api/auth/me')]);
    state.config = config;
    state.categories = catalog.categories;
    state.products = catalog.products;
    state.user = me.user;
    renderHeader();
    renderChips();
    renderCatalog();
    renderCart();
  } catch (err) {
    $('#catalog').innerHTML = `<p class="empty">No se pudo cargar la tienda: ${esc(err.message)}</p>`;
  }
}

init();
