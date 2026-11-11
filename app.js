import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';

const cfg = window.INVENTORY_CONFIG || {};
const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
const toastEl = document.getElementById('toast');

const PAGE = 50;
const BIN_RE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
const STATUS_TEXT = { ok: 'In stock', low: 'Low', out: 'Out' };

let sb = null;
let session = null;
let member = null;
let renderSeq = 0;
let lastRouted = '';

/* ---------- helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const normBin = (s) => String(s ?? '').trim().toUpperCase();
const isAdmin = () => member?.role === 'admin';
const appBase = () => location.origin + location.pathname;
const tagUrl = (id) => `${appBase()}?bin=${encodeURIComponent(id)}`;
const statusOf = (qty, reorderAt) => (qty === 0 ? 'out' : qty <= reorderAt ? 'low' : 'ok');
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
const who = (email) => (email ? email.split('@')[0] : 'someone');
// Characters that would break a PostgREST filter string.
const cleanSearch = (s) => String(s || '').replace(/[%,()"\\*]/g, ' ').trim();
const fd = (form) => Object.fromEntries(new FormData(form).entries());
const blankToNull = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

// Each view calls begin(); if another view starts before this one finishes
// loading, the stale one stops instead of overwriting the screen.
function begin() {
  const seq = ++renderSeq;
  return () => seq === renderSeq;
}

function loading() {
  app.innerHTML = '<p class="loading">Loading…</p>';
}

function show(html) {
  app.innerHTML = html;
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg, kind = 'info') {
  toastEl.textContent = msg;
  toastEl.dataset.kind = kind;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, kind === 'error' ? 6000 : 2500);
}

function errMsg(e) {
  const m = e?.message || String(e);
  if (/duplicate key/i.test(m)) return 'That already exists.';
  if (/row-level security|permission denied/i.test(m)) return 'You don’t have permission to do that.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Can’t reach the inventory server. Check your connection and try again.';
  return m;
}

// Disable a form's buttons while an async action runs; report errors.
async function busy(el, fn) {
  const buttons = el.matches('button') ? [el] : $$('button', el);
  buttons.forEach((b) => { b.disabled = true; });
  try {
    return await fn();
  } catch (e) {
    toast(errMsg(e), 'error');
    return undefined;
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

function go(hash) {
  history.pushState(null, '', appBase() + hash);
  route(true);
}

function timeAgo(iso) {
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: s > 31536000 ? 'numeric' : undefined });
}

function deltaHtml(n) {
  const cls = n > 0 ? 'up' : 'down';
  return `<span class="delta ${cls}">${n > 0 ? '+' : '−'}${Math.abs(n)}</span>`;
}

function statusLine(p) {
  if (p.status === 'out') return 'Out of stock';
  if (p.status === 'low') return `Low. Reorder point is ${p.reorder_at}.`;
  return p.reorder_at > 0 ? `Reorder point is ${p.reorder_at}` : 'No reorder point set';
}

function metaLine(p) {
  const bits = [p.sku, p.category].filter(Boolean);
  return bits.length ? `<p class="part-meta">${bits.map((b) => `<span>${esc(b)}</span>`).join('')}</p>` : '';
}

function viewError(e) {
  show(`<section class="panel narrow"><h1>Something went wrong</h1>
    <p>${esc(errMsg(e))}</p><p><a class="btn" href="#/">Go to parts</a></p></section>`);
}

function viewMessage(title, body, href = '#/', label = 'Go to parts') {
  show(`<section class="panel narrow"><h1>${esc(title)}</h1><p>${esc(body)}</p>
    <p><a class="btn" href="${href}">${esc(label)}</a></p></section>`);
}

/* ---------- startup and auth ---------- */

async function init() {
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || cfg.supabaseUrl.includes('YOUR-')) {
    show(`<section class="panel narrow"><h1>Almost there</h1>
      <p>Add your Supabase project URL and anon key to <code>config.js</code>, then reload this page.
      The README walks through it.</p></section>`);
    return;
  }
  const name = cfg.shopName || 'Shop Inventory';
  document.title = name;
  $('.brand').textContent = name;

  sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const { data } = await sb.auth.getSession();
  session = data.session;

  sb.auth.onAuthStateChange((_event, s) => {
    const before = session?.user?.id;
    session = s;
    // Supabase recommends not awaiting its own calls inside this callback.
    if (s?.user?.id !== before) setTimeout(start, 0);
  });

  window.addEventListener('hashchange', () => { if (member) route(); });
  window.addEventListener('popstate', () => { if (member) route(); });
  $('#signout').addEventListener('click', async () => {
    await sb.auth.signOut();
    history.replaceState(null, '', appBase());
  });

  await start();
}

async function start() {
  member = null;
  topbar.hidden = true;
  if (!session) return viewLogin();

  loading();
  const email = (session.user.email || '').toLowerCase();
  const { data, error } = await sb.from('members').select('email, role').eq('email', email).maybeSingle();
  if (error) return viewError(error);
  if (!data) return viewNotMember(email);

  member = data;
  topbar.hidden = false;
  $$('[data-admin]').forEach((el) => { el.hidden = !isAdmin(); });
  route(true);
}

function viewLogin() {
  const scanned = new URLSearchParams(location.search).get('bin');
  show(`
    <section class="panel narrow">
      <h1>Sign in</h1>
      <p class="muted">${scanned
        ? `You scanned bin <strong>${esc(normBin(scanned))}</strong>. Sign in once on this phone and later scans open the bin directly.`
        : 'Enter your email and we’ll send you a sign-in code.'}</p>
      <form id="emailForm" class="stack">
        <label>Email<input name="email" type="email" required autocomplete="email" inputmode="email"></label>
        <button class="btn primary" type="submit">Send code</button>
      </form>
      <form id="codeForm" class="stack" hidden>
        <p>Enter the code we sent to <strong id="sentTo"></strong>.</p>
        <label>Code<input name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10"></label>
        <button class="btn primary" type="submit">Sign in</button>
        <button class="btn quiet" type="button" id="changeEmail">Use a different email</button>
      </form>
    </section>`);

  const ef = $('#emailForm');
  const cf = $('#codeForm');
  let email = '';

  ef.addEventListener('submit', (e) => {
    e.preventDefault();
    email = fd(ef).email.trim().toLowerCase();
    busy(ef, async () => {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, emailRedirectTo: location.href },
      });
      if (error) throw error;
      $('#sentTo').textContent = email;
      ef.hidden = true;
      cf.hidden = false;
      cf.querySelector('input').focus();
    });
  });

  cf.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(cf, async () => {
      const { error } = await sb.auth.verifyOtp({ email, token: fd(cf).code.trim(), type: 'email' });
      if (error) throw error;
      // onAuthStateChange takes it from here.
    });
  });

  $('#changeEmail').addEventListener('click', () => {
    cf.hidden = true;
    ef.hidden = false;
  });
}

function viewNotMember(email) {
  show(`<section class="panel narrow">
    <h1>Not on the member list yet</h1>
    <p>You’re signed in as <strong>${esc(email)}</strong>, but this email hasn’t been added to the shop.
    Ask an admin to add it under Members, then reload this page.</p>
    <p class="actions"><button class="btn" id="reload">Reload</button>
    <button class="btn quiet" id="out">Sign out</button></p></section>`);
  $('#reload').addEventListener('click', start);
  $('#out').addEventListener('click', () => sb.auth.signOut());
}

/* ---------- routing ---------- */

function route(force = false) {
  if (!force && location.href === lastRouted) return;
  lastRouted = location.href;

  const bin = new URLSearchParams(location.search).get('bin');
  const [page, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : '';

  // A tag link (?bin=X) with no #route opens that bin.
  const current = !location.hash && bin ? 'bin' : page || 'parts';
  $$('[data-nav]').forEach((a) => {
    const active = a.dataset.nav === current || (current === 'reorder' && a.dataset.nav === 'parts');
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });

  if (!location.hash && bin) return viewBin(bin);
  switch (page) {
    case '':
    case 'parts': return viewParts();
    case 'reorder': return viewParts({ filter: 'reorder' });
    case 'part': return viewPart(arg);
    case 'bin': return viewBin(arg);
    case 'new': return viewNewPart(arg);
    case 'bins': return viewBins();
    case 'log': return viewLog();
    case 'members': return isAdmin() ? viewMembers() : viewParts();
    default: return viewParts();
  }
}

/* ---------- bin page (what a tag scan opens) ---------- */

async function viewBin(rawId) {
  const id = normBin(rawId);
  if (!BIN_RE.test(id)) {
    return viewMessage('That tag link isn’t valid', `“${rawId}” isn’t a bin ID this system can use. Bin IDs are letters, numbers, dashes and underscores.`);
  }
  const ok = begin();
  loading();
  const { data: bin, error } = await sb.from('bins').select('id, location, part_id').eq('id', id).maybeSingle();
  if (!ok()) return;
  if (error) return viewError(error);
  if (!bin) return viewUnknownBin(id);
  if (!bin.part_id) return viewEmptyBin(bin);
  return viewPart(bin.part_id, bin);
}

function viewUnknownBin(id) {
  show(`
    <article class="label-card" data-status="ok">
      <header class="label-head"><span class="bin-id">${esc(id)}</span></header>
      <div class="label-body">
        <h1 class="part-name">New bin</h1>
        <p class="muted">This tag isn’t linked to a bin yet. Set it up and choose what goes in it.</p>
      </div>
    </article>
    <form id="setup" class="panel stack">
      <label>Where is this bin? <span class="hint">Optional, e.g. “Wall rack, row 3”</span>
        <input name="location" autocomplete="off"></label>
      <button class="btn primary" type="submit">Set up bin ${esc(id)}</button>
    </form>`);
  const f = $('#setup');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(f, async () => {
      const { error } = await sb.from('bins').insert({ id, location: blankToNull(fd(f).location) });
      if (error) throw error;
      toast(`Bin ${id} set up`);
      viewBin(id);
    });
  });
}

function viewEmptyBin(bin) {
  show(`
    <article class="label-card" data-status="ok">
      <header class="label-head">
        <span class="bin-id">${esc(bin.id)}</span>
        ${bin.location ? `<span class="bin-loc">${esc(bin.location)}</span>` : ''}
      </header>
      <div class="label-body">
        <h1 class="part-name">Empty bin</h1>
        <p class="muted">Pick the part that lives here, or add a new one.</p>
      </div>
    </article>
    <section class="panel">
      <h2>Use an existing part</h2>
      <input id="pickQ" type="search" placeholder="Search parts" autocomplete="off">
      <ul class="picker-results" id="pickResults"></ul>
    </section>
    <p><a class="btn primary" href="#/new/${encodeURIComponent(bin.id)}">Add a new part to this bin</a></p>`);

  partPicker($('#pickQ'), $('#pickResults'), async (part) => {
    const { error } = await sb.from('bins').update({ part_id: part.id }).eq('id', bin.id);
    if (error) throw error;
    toast(`${part.name} is now in bin ${bin.id}`);
    viewBin(bin.id);
  });
}

function partPicker(input, list, onPick) {
  let seq = 0;
  let timer;
  const search = async () => {
    const mine = ++seq;
    const s = cleanSearch(input.value);
    let q = sb.from('part_status').select('id, name, sku, quantity, unit, bin_ids').order('name').limit(8);
    if (s) q = q.or(`name.ilike."%${s}%",sku.ilike."%${s}%",category.ilike."%${s}%"`);
    const { data, error } = await q;
    if (mine !== seq) return;
    if (error) { toast(errMsg(error), 'error'); return; }
    list.innerHTML = data.length
      ? data.map((p) => `<li><button class="btn" type="button" data-id="${p.id}">
          ${esc(p.name)}${p.sku ? ` <span class="muted">${esc(p.sku)}</span>` : ''}
          <span class="muted">${p.quantity} ${esc(p.unit)}${p.bin_ids ? `, in ${esc(p.bin_ids)}` : ''}</span>
        </button></li>`).join('')
      : '<li class="muted">No parts match.</li>';
    $$('button', list).forEach((b) => b.addEventListener('click', () => {
      const p = data.find((x) => x.id === b.dataset.id);
      busy(list, () => onPick(p));
    }));
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  search();
}

/* ---------- part page ---------- */

async function viewPart(partId, bin = null) {
  const ok = begin();
  if (!bin) loading();
  const [partRes, binsRes, logRes] = await Promise.all([
    sb.from('part_status').select('*').eq('id', partId).maybeSingle(),
    sb.from('bins').select('id, location').eq('part_id', partId).order('id'),
    loadPartLog(partId),
  ]);
  if (!ok()) return;
  const err = partRes.error || binsRes.error || logRes.error;
  if (err) return viewError(err);
  const part = partRes.data;
  if (!part) return viewMessage('Part not found', 'It may have been deleted.');
  const bins = binsRes.data;

  const headId = bin ? bin.id : bins.length ? bins.map((b) => b.id).join(', ') : 'No bin';
  const headLoc = bin ? bin.location : bins.length === 1 ? bins[0].location : '';
  const reorderUrl = safeUrl(part.reorder_url);

  show(`
    <article class="label-card" id="card" data-status="${part.status}">
      <header class="label-head">
        <span class="bin-id">${esc(headId)}</span>
        ${headLoc ? `<span class="bin-loc">${esc(headLoc)}</span>` : ''}
      </header>
      <div class="label-body">
        <h1 class="part-name">${esc(part.name)}</h1>
        ${metaLine(part)}
        <p class="count"><span class="qty" id="qty">${part.quantity}</span><span class="unit">${esc(part.unit)}</span></p>
        <p class="status-line" id="statusLine">${esc(statusLine(part))}</p>
      </div>
    </article>

    <section class="adjust" aria-label="Change the count">
      <div class="steppers">
        <button class="btn step take" type="button" data-delta="-1" aria-label="Take one">−1</button>
        <button class="btn step add" type="button" data-delta="1" aria-label="Add one">+1</button>
      </div>
      <form id="amountForm" class="amount">
        <label class="sr-only" for="amount">Amount</label>
        <input id="amount" name="amount" type="number" min="0" step="1" inputmode="numeric" placeholder="Amount" required>
        <button class="btn" type="submit" value="take">Take</button>
        <button class="btn" type="submit" value="add">Add</button>
        <button class="btn" type="submit" value="set">Set count</button>
      </form>
      <p class="undo-row"><button class="btn quiet" type="button" id="undo" hidden>Undo last change</button></p>
    </section>

    ${reorderUrl ? `<p class="reorder-link"><a class="btn" href="${esc(reorderUrl)}" target="_blank" rel="noopener">Reorder${part.supplier ? ` from ${esc(part.supplier)}` : ''}</a></p>` : ''}

    <section class="panel">
      <h2>Recent activity</h2>
      <ol class="log" id="log">${logItems(logRes.data)}</ol>
    </section>

    <section class="panel">
      <h2>Bins</h2>
      ${bins.length ? `<ul class="chips">${bins.map((b) => `
        <li><a href="#/bin/${encodeURIComponent(b.id)}">${esc(b.id)}</a>
        ${b.location ? `<span class="muted">${esc(b.location)}</span>` : ''}
        <button class="link-btn" type="button" data-unlink="${esc(b.id)}">Remove from this part</button></li>`).join('')}</ul>`
        : '<p class="muted">This part isn’t in any bin yet.</p>'}
      <form id="linkBin" class="inline">
        <label class="sr-only" for="linkBinId">Bin ID</label>
        <input id="linkBinId" name="bin" placeholder="Bin ID, e.g. A-014" required autocapitalize="characters" autocomplete="off">
        <button class="btn" type="submit">Add bin</button>
      </form>
    </section>

    <details class="panel">
      <summary>Edit part details</summary>
      <form id="editForm" class="stack">
        ${partFields(part)}
        <div class="actions">
          <button class="btn primary" type="submit">Save changes</button>
          ${isAdmin() ? '<button class="btn danger" type="button" id="deletePart">Delete part</button>' : ''}
        </div>
      </form>
    </details>`);

  fillCategories();
  const reload = () => (bin ? viewBin(bin.id) : viewPart(part.id));
  let qty = part.quantity;
  let lastDelta = 0;
  const undoBtn = $('#undo');
  const adjustArea = $('.adjust');

  const paint = () => {
    const status = statusOf(qty, part.reorder_at);
    $('#card').dataset.status = status;
    const q = $('#qty');
    q.textContent = qty;
    q.classList.remove('bump');
    void q.offsetWidth; // restart the animation
    q.classList.add('bump');
    $('#statusLine').textContent = statusLine({ ...part, status });
  };

  const refreshLog = async () => {
    const { data } = await loadPartLog(part.id);
    if (data && document.contains($('#log'))) $('#log').innerHTML = logItems(data);
  };

  const change = (op, n, reason = null) => busy(adjustArea, async () => {
    const args = { p_part_id: part.id, p_bin_id: bin?.id ?? null, p_reason: reason };
    const before = qty;
    const res = op === 'set'
      ? await sb.rpc('set_stock', { ...args, p_quantity: n })
      : await sb.rpc('adjust_stock', { ...args, p_delta: op === 'take' ? -n : n });
    if (res.error) throw res.error;
    qty = res.data;
    lastDelta = op === 'set' ? qty - before : (op === 'take' ? -n : n);
    navigator.vibrate?.(12);
    paint();
    undoBtn.hidden = reason === 'Undo' || lastDelta === 0;
    refreshLog();
    return true;
  });

  $$('.step').forEach((b) => b.addEventListener('click', () => {
    const d = Number(b.dataset.delta);
    change(d > 0 ? 'add' : 'take', Math.abs(d));
  }));

  const af = $('#amountForm');
  af.addEventListener('submit', async (e) => {
    e.preventDefault();
    const op = e.submitter?.value || 'add';
    const n = Number(fd(af).amount);
    if (!Number.isInteger(n) || n < 0 || (op !== 'set' && n === 0)) {
      toast('Enter a whole number greater than zero.', 'error');
      return;
    }
    if (await change(op, n)) af.reset();
  });

  undoBtn.addEventListener('click', () => {
    if (!lastDelta) return;
    change(lastDelta > 0 ? 'take' : 'add', Math.abs(lastDelta), 'Undo');
  });

  $$('[data-unlink]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
    const { error } = await sb.from('bins').update({ part_id: null }).eq('id', b.dataset.unlink);
    if (error) throw error;
    toast(`Bin ${b.dataset.unlink} is now empty`);
    if (bin && bin.id === b.dataset.unlink) viewPart(part.id); else reload();
  })));

  const lf = $('#linkBin');
  lf.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = normBin(fd(lf).bin);
    if (!BIN_RE.test(id)) { toast('Bin IDs are letters, numbers, dashes and underscores.', 'error'); return; }
    busy(lf, async () => {
      if (await assignBin(id, part)) { toast(`Bin ${id} added`); reload(); }
    });
  });

  const ef = $('#editForm');
  ef.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(ef, async () => {
      const { error } = await sb.from('parts').update(readPartFields(ef)).eq('id', part.id);
      if (error) throw error;
      toast('Changes saved');
      reload();
    });
  });

  $('#deletePart')?.addEventListener('click', (e) => {
    if (!confirm(`Delete “${part.name}” and its history? Its bins will become empty.`)) return;
    busy(e.currentTarget, async () => {
      const { error } = await sb.from('parts').delete().eq('id', part.id);
      if (error) throw error;
      toast('Part deleted');
      go('#/');
    });
  });
}

function loadPartLog(partId) {
  return sb.from('stock_log')
    .select('delta, quantity_after, reason, user_email, created_at, bin_id')
    .eq('part_id', partId)
    .order('created_at', { ascending: false })
    .limit(8);
}

function logItems(rows) {
  if (!rows?.length) return '<li class="muted">No changes yet.</li>';
  return rows.map((r) => `
    <li>${deltaHtml(r.delta)}
      <span>${esc(who(r.user_email))}${r.reason ? `, ${esc(r.reason.toLowerCase())}` : ''}
        <small class="muted">now ${r.quantity_after}${r.bin_id ? `, bin ${esc(r.bin_id)}` : ''}</small></span>
      <time datetime="${esc(r.created_at)}">${esc(timeAgo(r.created_at))}</time></li>`).join('');
}

// Put a bin under a part, creating the bin if needed. Asks before moving a
// bin away from a different part.
async function assignBin(id, part) {
  const { data: existing, error } = await sb.from('bins').select('id, part_id').eq('id', id).maybeSingle();
  if (error) throw error;
  if (existing?.part_id === part.id) return true;
  if (existing?.part_id && !confirm(`Bin ${id} holds a different part right now. Move it to “${part.name}”?`)) return false;
  const res = existing
    ? await sb.from('bins').update({ part_id: part.id }).eq('id', id)
    : await sb.from('bins').insert({ id, part_id: part.id });
  if (res.error) throw res.error;
  return true;
}

/* ---------- part form ---------- */

let categoryCache = null;
async function categoryOptions() {
  if (!categoryCache) {
    const { data } = await sb.from('part_categories').select('category').limit(1000);
    categoryCache = (data || []).map((r) => r.category);
  }
  return categoryCache;
}

function partFields(p = {}) {
  return `
    <label>Name<input name="partName" required value="${esc(p.name)}" autocomplete="off"></label>
    <div class="grid-2">
      <label>SKU or part number<input name="sku" value="${esc(p.sku)}" autocomplete="off"></label>
      <label>Category<input name="category" list="categoryList" value="${esc(p.category)}" autocomplete="off"></label>
    </div>
    <datalist id="categoryList"></datalist>
    <div class="grid-2">
      <label>Unit<input name="unit" value="${esc(p.unit ?? 'pcs')}" placeholder="pcs" autocomplete="off"></label>
      <label>Reorder point <span class="hint">Alert when the count drops to this</span>
        <input name="reorder_at" type="number" min="0" step="1" inputmode="numeric" value="${esc(p.reorder_at ?? 0)}"></label>
    </div>
    <div class="grid-2">
      <label>Supplier<input name="supplier" value="${esc(p.supplier)}" autocomplete="off"></label>
      <label>Reorder link<input name="reorder_url" type="url" value="${esc(p.reorder_url)}" placeholder="https://"></label>
    </div>
    <label>Notes<textarea name="notes">${esc(p.notes)}</textarea></label>`;
}

function readPartFields(form) {
  const v = fd(form);
  const reorder = Math.max(0, Math.floor(Number(v.reorder_at) || 0));
  return {
    name: v.partName.trim(),
    sku: blankToNull(v.sku),
    category: blankToNull(v.category),
    unit: blankToNull(v.unit) || 'pcs',
    reorder_at: reorder,
    supplier: blankToNull(v.supplier),
    reorder_url: blankToNull(v.reorder_url),
    notes: blankToNull(v.notes),
  };
}

async function fillCategories() {
  const list = $('#categoryList');
  if (!list) return;
  const cats = await categoryOptions();
  list.innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');
}

function viewNewPart(binArg) {
  begin();
  const binId = binArg ? normBin(binArg) : '';
  show(`
    <div class="title-row"><h1>New part</h1></div>
    <form id="newForm" class="panel stack">
      ${partFields()}
      <div class="grid-2">
        <label>Starting count<input name="start" type="number" min="0" step="1" inputmode="numeric" value="0"></label>
        <label>Bin ID <span class="hint">Optional</span>
          <input name="bin" value="${esc(binId)}" placeholder="e.g. A-014" autocapitalize="characters" autocomplete="off"></label>
      </div>
      <div class="actions">
        <button class="btn primary" type="submit">Add part</button>
        <a class="btn quiet" href="${binId ? `#/bin/${encodeURIComponent(binId)}` : '#/'}">Cancel</a>
      </div>
    </form>`);
  fillCategories();
  const f = $('#newForm');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = fd(f);
    const bin = normBin(v.bin);
    const start = Math.floor(Number(v.start) || 0);
    if (bin && !BIN_RE.test(bin)) { toast('Bin IDs are letters, numbers, dashes and underscores.', 'error'); return; }
    if (start < 0) { toast('Starting count must be zero or more.', 'error'); return; }
    busy(f, async () => {
      const { data: part, error } = await sb.from('parts').insert(readPartFields(f)).select('id, name').single();
      if (error) throw error;
      categoryCache = null;
      if (bin) await assignBin(bin, part);
      if (start > 0) {
        const r = await sb.rpc('adjust_stock', { p_part_id: part.id, p_delta: start, p_bin_id: bin || null, p_reason: 'Starting count' });
        if (r.error) throw r.error;
      }
      toast(`${part.name} added`);
      go(bin ? `#/bin/${encodeURIComponent(bin)}` : `#/part/${part.id}`);
    });
  });
}

/* ---------- parts list ---------- */

const listState = { q: '', filter: 'all', category: '', sort: 'name' };

async function viewParts(preset) {
  if (preset) Object.assign(listState, preset);
  const ok = begin();
  show(`
    <div class="title-row"><h1>Parts</h1><a class="btn primary" href="#/new">New part</a></div>
    <div class="summary" id="summary"></div>
    <form id="filters" class="filters" role="search">
      <label class="sr-only" for="q">Search</label>
      <input id="q" type="search" name="q" placeholder="Search name, SKU, category or bin" value="${esc(listState.q)}" autocomplete="off">
      <select name="category" aria-label="Category"><option value="">All categories</option></select>
      <select name="filter" aria-label="Stock">
        <option value="all">All stock</option>
        <option value="reorder">Needs reorder</option>
        <option value="out">Out of stock</option>
      </select>
      <select name="sort" aria-label="Sort">
        <option value="name">Name</option>
        <option value="stock">Lowest stock first</option>
        <option value="recent">Recently changed</option>
      </select>
    </form>
    <ul class="rows" id="rows"></ul>
    <p class="more"><button class="btn quiet" id="more" type="button" hidden>Show more</button></p>`);

  const f = $('#filters');
  f.filter.value = listState.filter;
  f.sort.value = listState.sort;

  let offset = 0;
  let seq = 0;

  const loadRows = async (reset) => {
    const mine = ++seq;
    if (reset) offset = 0;
    let q = sb.from('part_status')
      .select('id, name, sku, category, quantity, unit, status, bin_ids', { count: 'exact' });
    const s = cleanSearch(listState.q);
    if (s) q = q.or(`name.ilike."%${s}%",sku.ilike."%${s}%",category.ilike."%${s}%",bin_ids.ilike."%${s}%"`);
    if (listState.category) q = q.eq('category', listState.category);
    if (listState.filter === 'reorder') q = q.in('status', ['low', 'out']);
    if (listState.filter === 'out') q = q.eq('status', 'out');
    if (listState.sort === 'stock') q = q.order('status_rank').order('quantity').order('name');
    else if (listState.sort === 'recent') q = q.order('updated_at', { ascending: false });
    else q = q.order('name');
    const { data, count, error } = await q.range(offset, offset + PAGE - 1);
    if (!ok() || mine !== seq) return;
    if (error) { toast(errMsg(error), 'error'); return; }

    const rows = $('#rows');
    const html = data.map((p) => `
      <li data-status="${p.status}"><a class="row" href="#/part/${p.id}">
        <span class="r-name">${esc(p.name)}<small>${esc([p.sku, p.category].filter(Boolean).join(' / '))}</small></span>
        <span class="r-bins">${esc(p.bin_ids || 'No bin')}</span>
        <span class="r-qty"><b>${p.quantity}</b> ${esc(p.unit)}</span>
        <span class="pill">${STATUS_TEXT[p.status]}</span>
      </a></li>`).join('');
    if (reset) rows.innerHTML = html; else rows.insertAdjacentHTML('beforeend', html);
    offset += data.length;
    $('#more').hidden = offset >= (count ?? 0);
    if (count === 0) {
      const anyFilter = s || listState.category || listState.filter !== 'all';
      rows.innerHTML = `<li class="empty">${anyFilter
        ? 'No parts match these filters.'
        : 'No parts yet. Add your first part, or scan a bin tag to set one up.'}</li>`;
    }
  };

  const loadSummary = async () => {
    const head = { count: 'exact', head: true };
    const [all, low, out] = await Promise.all([
      sb.from('parts').select('id', head),
      sb.from('part_status').select('id', head).eq('status', 'low'),
      sb.from('part_status').select('id', head).eq('status', 'out'),
    ]);
    if (!ok()) return;
    const el = $('#summary');
    el.innerHTML = `
      <button type="button" data-set="all" aria-pressed="${listState.filter === 'all'}">${all.count ?? 0} parts</button>
      <button type="button" data-set="reorder" data-tone="low" aria-pressed="${listState.filter === 'reorder'}">${(low.count ?? 0) + (out.count ?? 0)} need reorder</button>
      <button type="button" data-set="out" data-tone="out" aria-pressed="${listState.filter === 'out'}">${out.count ?? 0} out</button>`;
    $$('button', el).forEach((b) => b.addEventListener('click', () => {
      listState.filter = b.dataset.set;
      f.filter.value = listState.filter;
      $$('button', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      loadRows(true);
    }));
  };

  categoryOptions().then((cats) => {
    if (!ok()) return;
    f.category.insertAdjacentHTML('beforeend', cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join(''));
    f.category.value = listState.category;
  });

  let timer;
  f.addEventListener('input', (e) => {
    if (e.target.name !== 'q') return;
    clearTimeout(timer);
    timer = setTimeout(() => { listState.q = e.target.value; loadRows(true); }, 250);
  });
  f.addEventListener('change', (e) => {
    if (e.target.name === 'q') return;
    listState[e.target.name] = e.target.value;
    if (e.target.name === 'filter') {
      $$('#summary button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.set === listState.filter)));
    }
    loadRows(true);
  });
  f.addEventListener('submit', (e) => e.preventDefault());
  $('#more').addEventListener('click', (e) => busy(e.currentTarget, () => loadRows(false)));

  loadSummary();
  loadRows(true);
}

/* ---------- bins ---------- */

async function viewBins() {
  const ok = begin();
  show(`
    <div class="title-row"><h1>Bins</h1>
      <button class="btn" type="button" id="csv">Download tag list</button></div>
    <p class="muted">Each bin’s NFC tag holds its link. Copy a link, then write it to a sticker with an app like NFC Tools
      (Write, Add a record, URL).</p>

    <details class="panel">
      <summary>Add bins</summary>
      <form id="bulk" class="stack">
        <p class="muted" style="margin:0">Create a numbered run of bins in one go, e.g. A-001 to A-040.</p>
        <div class="grid-2">
          <label>Prefix<input name="prefix" value="A-" autocapitalize="characters" autocomplete="off"></label>
          <label>Digits <span class="hint">3 gives 001</span><input name="digits" type="number" min="1" max="6" value="3"></label>
          <label>From<input name="from" type="number" min="0" value="1" required></label>
          <label>To<input name="to" type="number" min="0" value="20" required></label>
        </div>
        <label>Location <span class="hint">Optional, applied to all of them</span><input name="location" autocomplete="off"></label>
        <div class="actions"><button class="btn primary" type="submit" id="bulkBtn">Create bins</button>
          <span class="muted" id="bulkPreview"></span></div>
      </form>
    </details>

    <form id="binSearch" role="search" style="margin:16px 0 12px">
      <label class="sr-only" for="bq">Search bins</label>
      <input id="bq" type="search" name="q" placeholder="Search bin ID or location" autocomplete="off">
    </form>
    <ul class="rows" id="binRows"></ul>
    <p class="more"><button class="btn quiet" id="moreBins" type="button" hidden>Show more</button></p>`);

  let offset = 0;
  let seq = 0;
  let query = '';

  const loadBins = async (reset) => {
    const mine = ++seq;
    if (reset) offset = 0;
    let q = sb.from('bins').select('id, location, part_id, parts(name)', { count: 'exact' }).order('id');
    const s = cleanSearch(query);
    if (s) q = q.or(`id.ilike."%${s}%",location.ilike."%${s}%"`);
    const { data, count, error } = await q.range(offset, offset + PAGE - 1);
    if (!ok() || mine !== seq) return;
    if (error) { toast(errMsg(error), 'error'); return; }
    const html = data.map((b) => `
      <li><div class="bin-row">
        <a class="bin-code" href="#/bin/${encodeURIComponent(b.id)}">${esc(b.id)}</a>
        <span>${b.part_id ? esc(b.parts?.name) : '<span class="muted">Empty</span>'}
          ${b.location ? `<small class="muted">${esc(b.location)}</small>` : ''}</span>
        <span class="actions">
          <button class="link-btn" type="button" data-copy="${esc(b.id)}">Copy tag link</button>
          <button class="link-btn" type="button" data-loc="${esc(b.id)}">Location</button>
          ${isAdmin() ? `<button class="link-btn danger" type="button" data-del="${esc(b.id)}">Delete</button>` : ''}
        </span>
      </div></li>`).join('');
    const rows = $('#binRows');
    if (reset) rows.innerHTML = html; else rows.insertAdjacentHTML('beforeend', html);
    offset += data.length;
    $('#moreBins').hidden = offset >= (count ?? 0);
    if (count === 0) rows.innerHTML = `<li class="empty">${s ? 'No bins match.' : 'No bins yet. Add a run of bins above, or scan a new tag.'}</li>`;
  };

  $('#binRows').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.copy) {
      const url = tagUrl(b.dataset.copy);
      try { await navigator.clipboard.writeText(url); toast('Tag link copied'); } catch { prompt('Copy this tag link:', url); }
    } else if (b.dataset.loc) {
      const loc = prompt(`Location for bin ${b.dataset.loc}:`);
      if (loc === null) return;
      busy(b, async () => {
        const { error } = await sb.from('bins').update({ location: blankToNull(loc) }).eq('id', b.dataset.loc);
        if (error) throw error;
        toast('Location saved');
        loadBins(true);
      });
    } else if (b.dataset.del) {
      if (!confirm(`Delete bin ${b.dataset.del}? Its part and counts stay; the tag will offer to set the bin up again.`)) return;
      busy(b, async () => {
        const { error } = await sb.from('bins').delete().eq('id', b.dataset.del);
        if (error) throw error;
        toast(`Bin ${b.dataset.del} deleted`);
        loadBins(true);
      });
    }
  });

  let timer;
  $('#bq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = e.target.value; loadBins(true); }, 250);
  });
  $('#binSearch').addEventListener('submit', (e) => e.preventDefault());
  $('#moreBins').addEventListener('click', (e) => busy(e.currentTarget, () => loadBins(false)));

  const bf = $('#bulk');
  const makeIds = () => {
    const v = fd(bf);
    const prefix = normBin(v.prefix);
    const digits = Math.min(6, Math.max(1, Number(v.digits) || 1));
    const from = Math.floor(Number(v.from));
    const to = Math.floor(Number(v.to));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return { error: '“From” must be at or below “To”.' };
    if (to - from + 1 > 500) return { error: 'Create at most 500 bins at a time.' };
    const ids = [];
    for (let n = from; n <= to; n++) ids.push(prefix + String(n).padStart(digits, '0'));
    const bad = ids.find((id) => !BIN_RE.test(id));
    if (bad) return { error: `${bad} isn’t a valid bin ID. Use letters, numbers, dashes and underscores (32 max).` };
    return { ids, location: blankToNull(v.location) };
  };
  const preview = () => {
    const r = makeIds();
    $('#bulkPreview').textContent = r.error || (r.ids.length === 1 ? r.ids[0] : `${r.ids[0]} to ${r.ids.at(-1)} (${r.ids.length} bins)`);
  };
  bf.addEventListener('input', preview);
  preview();
  bf.addEventListener('submit', (e) => {
    e.preventDefault();
    const r = makeIds();
    if (r.error) { toast(r.error, 'error'); return; }
    busy(bf, async () => {
      const rows = r.ids.map((id) => ({ id, location: r.location }));
      const { data, error } = await sb.from('bins')
        .upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
        .select('id');
      if (error) throw error;
      const made = data?.length ?? 0;
      const skipped = r.ids.length - made;
      toast(`${made} bin${made === 1 ? '' : 's'} created${skipped ? `, ${skipped} already existed` : ''}`);
      loadBins(true);
    });
  });

  $('#csv').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('bins').select('id, location, parts(name)').order('id').range(from, from + 999);
      if (error) throw error;
      all.push(...data);
      if (data.length < 1000) break;
    }
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['bin_id,location,part,tag_url']
      .concat(all.map((b) => [b.id, b.location, b.parts?.name, tagUrl(b.id)].map(cell).join(',')))
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'bin-tags.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }));

  loadBins(true);
}

/* ---------- activity ---------- */

async function viewLog() {
  const ok = begin();
  show(`<div class="title-row"><h1>Activity</h1></div>
    <section class="panel"><ol class="log" id="allLog"><li class="muted">Loading…</li></ol></section>
    <p class="more"><button class="btn quiet" id="moreLog" type="button" hidden>Show more</button></p>`);
  let offset = 0;
  const load = async (reset) => {
    const { data, error } = await sb.from('stock_log')
      .select('id, delta, quantity_after, reason, user_email, created_at, bin_id, parts(id, name)')
      .order('created_at', { ascending: false })
      .range(offset, offset + 99);
    if (!ok()) return;
    if (error) { toast(errMsg(error), 'error'); return; }
    const html = data.map((r) => `
      <li>${deltaHtml(r.delta)}
        <span>${r.parts ? `<a href="#/part/${r.parts.id}">${esc(r.parts.name)}</a>` : 'Deleted part'}
          <small class="muted">${esc(who(r.user_email))}${r.reason ? `, ${esc(r.reason.toLowerCase())}` : ''}, now ${r.quantity_after}${r.bin_id ? `, bin ${esc(r.bin_id)}` : ''}</small></span>
        <time datetime="${esc(r.created_at)}">${esc(timeAgo(r.created_at))}</time></li>`).join('');
    const list = $('#allLog');
    if (reset) list.innerHTML = html || '<li class="muted">No changes yet.</li>';
    else list.insertAdjacentHTML('beforeend', html);
    offset += data.length;
    $('#moreLog').hidden = data.length < 100;
  };
  $('#moreLog').addEventListener('click', (e) => busy(e.currentTarget, () => load(false)));
  load(true);
}

/* ---------- members (admins) ---------- */

async function viewMembers() {
  const ok = begin();
  loading();
  const { data, error } = await sb.from('members').select('email, role, added_at').order('email');
  if (!ok()) return;
  if (error) return viewError(error);
  show(`
    <div class="title-row"><h1>Members</h1></div>
    <p class="muted">People on this list can sign in with their email. Editors can count, add and edit parts and bins.
      Admins can also delete things and manage this list.</p>
    <form id="addMember" class="panel stack">
      <div class="grid-2">
        <label>Email<input name="email" type="email" required autocomplete="off"></label>
        <label>Role<select name="role"><option value="editor">Editor</option><option value="admin">Admin</option></select></label>
      </div>
      <div class="actions"><button class="btn primary" type="submit">Add member</button></div>
    </form>
    <ul class="rows">${data.map((m) => `
      <li><div class="bin-row">
        <span style="grid-column: span 2">${esc(m.email)}${m.email === member.email ? ' <span class="muted">(you)</span>' : ''}</span>
        <span class="actions">
          <select data-role="${esc(m.email)}" aria-label="Role for ${esc(m.email)}" ${m.email === member.email ? 'disabled' : ''}>
            <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Editor</option>
            <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
          ${m.email === member.email ? '' : `<button class="link-btn danger" type="button" data-remove="${esc(m.email)}">Remove</button>`}
        </span>
      </div></li>`).join('')}</ul>`);

  const f = $('#addMember');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = fd(f);
    busy(f, async () => {
      const { error: err } = await sb.from('members').insert({ email: v.email.trim().toLowerCase(), role: v.role });
      if (err) throw err;
      toast(`${v.email} added. They can sign in now.`);
      viewMembers();
    });
  });
  $$('[data-role]').forEach((s) => s.addEventListener('change', () => busy(s.parentElement, async () => {
    const { error: err } = await sb.from('members').update({ role: s.value }).eq('email', s.dataset.role);
    if (err) throw err;
    toast('Role updated');
  })));
  $$('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm(`Remove ${b.dataset.remove}? They’ll lose access right away.`)) return;
    busy(b, async () => {
      const { error: err } = await sb.from('members').delete().eq('email', b.dataset.remove);
      if (err) throw err;
      toast('Member removed');
      viewMembers();
    });
  }));
}

init().catch(viewError);
