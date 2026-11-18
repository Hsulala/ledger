// 帳房客戶端。不使用任何建置工具；所有使用者資料都用 textContent 寫入畫面（不拼 HTML 字串）。
const $app = document.getElementById('app');

// ---------- 小工具 ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const yuan = (x100) => (x100 === null || x100 === undefined ? '' : (x100 / 100).toString());
const money = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString('en-US'));
// 輸入不合法時原樣回傳文字，讓伺服器的驗證指出是哪個欄位（不默默吞掉）
const toX100 = (text) => { const t = String(text).trim(); if (t === '') return null; const n = Math.round(Number(t) * 100); return Number.isFinite(n) ? n : t; };
const toInt = (text) => { const t = String(text).trim(); if (t === '') return null; const n = Number(t); return Number.isInteger(n) ? n : t; };

async function api(method, path, body) {
  const init = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || `錯誤 ${res.status}`); err.status = res.status; err.data = data; throw err; }
  return data;
}

const DOC_TYPES = { quote: '估價單', delivery: '送貨單', shipment: '出貨單', sales: '銷貨單' };
const CATEGORIES = { bedding: '寢具', chicken_feet: '鳳爪', ready_meal: '調理包' };
const LINES = { product: '商品', freight: '運費', gift: '贈品' };
const TAX = { unknown: '未標示', excl: '未稅', incl: '含稅' };

// ---------- 主題色（店家可自訂，只動點綴色）----------
function applyTheme(color) {
  const root = document.documentElement.style;
  if (!/^#[0-9a-f]{6}$/.test(color ?? '')) { for (const k of ['--accent', '--accent-soft', '--accent-ink']) root.removeProperty(k); return; }
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const mix = (c) => Math.round(c + (255 - c) * 0.88).toString(16).padStart(2, '0');
  root.setProperty('--accent', color);
  root.setProperty('--accent-soft', `#${mix(r)}${mix(g)}${mix(b)}`);
  root.setProperty('--accent-ink', (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#1f2933' : '#ffffff');
}

// ---------- 狀態 ----------
const state = { me: null, companyId: null, masters: {} };
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 無痕模式等情況略過 */ } };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

async function loadMasters() {
  const kinds = ['vendors', 'products', 'customers'];
  const results = await Promise.all(kinds.map((k) => api('GET', `/api/master/${k}`)));
  kinds.forEach((k, i) => { state.masters[k] = results[i].rows; });
}
const nameOf = (list, id) => (state.masters[list] ?? []).find((r) => r.id === id)?.name ?? '';
const cid = () => state.companyId;
// 依記住的選擇或第一家公司決定目前公司；建立買方公司後也要呼叫
function pickCompany() {
  const list = state.me.companies;
  state.companyId = list.find((c) => c.id === state.companyId)?.id ?? list.find((c) => c.id === recall('ledger_company'))?.id ?? list[0]?.id ?? null;
}

// ---------- 版面 ----------
const NAV = [['upload', '上傳'], ['pending', '待確認'], ['purchases', '進貨'], ['orders', '訂單'], ['settings', '設定']];

function shell(active, ...content) {
  const { me } = state;
  const select = h('select', { onchange: (e) => { state.companyId = e.target.value; remember('ledger_company', state.companyId); route(); }, style: 'width:auto' },
    me.companies.map((c) => h('option', { value: c.id, selected: c.id === cid() }, c.name)));
  return [
    h('header', { class: 'top' },
      h('span', { class: 'brand' }, '帳房'), h('span', { class: 'store' }, me.store.name),
      me.companies.length ? select : h('span', { class: 'muted' }, '尚未建立買方公司'),
      h('nav', {}, NAV.map(([key, label]) => h('a', { href: `#/${key}`, class: key === active ? 'on' : '' }, label))),
      h('span', { class: 'muted' }, me.user.display_name),
      h('button', { class: 'btn small', onclick: async () => { await api('POST', '/api/auth/logout'); location.hash = ''; location.reload(); } }, '登出')),
    h('main', {}, ...content),
  ];
}
const mount = (nodes) => { $app.replaceChildren(...[nodes].flat()); };
const needCompany = () => h('div', { class: 'notice warn' }, '請先到「設定」建立買方公司，才能上傳與輸入單據。');

// ---------- 登入 ----------
function loginView() {
  const err = new URLSearchParams(location.search).get('login_error');
  const messages = { unbound: '這個 LINE 帳號還沒有綁定，請向管理者索取綁定連結。', state: '登入逾時，請再試一次。', line: 'LINE 驗證失敗，請再試一次。', invite: '綁定連結無效或已使用。', bind: '綁定失敗，請向管理者重新索取連結。', cancelled: '已取消登入。' };
  mount(h('div', { class: 'center' }, h('h1', {}, '帳房'), h('p', { class: 'muted' }, '進銷存對帳'),
    err ? h('div', { class: 'notice err' }, messages[err] ?? '登入失敗') : null,
    h('p', {}, h('a', { class: 'btn primary', href: '/auth/line/start', style: 'display:inline-block;padding:10px 28px' }, '使用 LINE 登入'))));
}

// ---------- 上傳頁 ----------
function uploadView() {
  const result = h('div', {});
  const input = h('input', { type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/webp,application/pdf', class: 'hidden' });
  const zone = h('div', { class: 'dropzone' }, h('p', {}, '把單據照片拖到這裡，或'), h('button', { class: 'btn', onclick: () => input.click() }, '選擇檔案'), h('p', { class: 'muted' }, '可一次多張；JPEG、PNG、WebP 或 PDF，每個檔案 15 MB 內'));

  const aiReady = cid() ? api('GET', `/api/c/${cid()}/ai-usage`).catch(() => ({ enabled: false })) : Promise.resolve({ enabled: false });

  async function recognizeNow(ids, button) {
    button.disabled = true;
    result.append(h('p', { class: 'muted', id: 'ai-wait' }, 'AI 判讀中，通常需要 10 到 40 秒…'));
    const finish = () => { button.disabled = false; document.getElementById('ai-wait')?.remove(); };
    const show = (node) => result.append(node);
    try {
      const r = await api('POST', `/api/c/${cid()}/recognize`, { file_ids: ids });
      finish();
      handleResult(r, ids, button);
    } catch (e) { finish(); show(h('div', { class: 'notice err' }, e.message)); }
  }
  function handleResult(r, ids, button) {
    if (r.status === 'draft') { location.hash = `#/doc/${r.kind}/${r.id}`; return; }
    const box = h('div', { class: 'notice warn' }, r.message);
    if (r.status === 'need_vendor' || r.status === 'need_customer') {
      box.append(h('p', {}, h('a', { class: 'btn', href: `#/settings/${r.status === 'need_vendor' ? 'vendors' : 'customers'}` }, '到設定新增'), ' ',
        h('button', { class: 'btn primary', onclick: async () => {
          try { const again = await api('POST', `/api/c/${cid()}/extractions/${r.extraction_id}/build`, {}); handleResult(again, ids, button); } catch (e) { box.append(h('div', { class: 'notice err' }, e.message)); }
        } }, '建好了，重新比對')));
    }
    result.append(box);
  }

  async function send(files) {
    if (!files.length) return;
    result.replaceChildren(h('p', { class: 'muted' }, `上傳中（${files.length} 個檔案）…`));
    const form = new FormData();
    for (const f of files) form.append('files', f);
    try {
      const { files: out } = await api('POST', `/api/c/${cid()}/files`, form);
      const ai = await aiReady;
      const ok = out.filter((f) => f.id);
      const fresh = ok.filter((f) => !f.duplicate);
      const ids = [...new Set(ok.map((f) => f.id))];
      result.replaceChildren(
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '檔名'), h('th', {}, '結果'))),
          h('tbody', {}, out.map((f) => h('tr', {}, h('td', {}, f.name), h('td', {}, f.error ? h('span', { class: 'tag warn' }, f.error) : f.duplicate ? h('span', { class: 'tag warn' }, '重複，已有相同照片') : h('span', { class: 'tag ok' }, '已上傳')))))),
        ids.length ? h('div', { class: 'actions', style: 'position:static;border:0' },
          h('span', { class: 'muted' }, `${fresh.length} 張新照片，${ok.length - fresh.length} 張重複`),
          ai.enabled ? (() => { const b = h('button', { class: 'btn primary' }, 'AI 判讀（這些檔案視為同一份單據）'); b.addEventListener('click', () => recognizeNow(ids, b)); return b; })() : null,
          h('a', { class: 'btn', href: `#/doc/purchase/new?files=${ids.join(',')}` }, '手動建立進貨單'),
          h('a', { class: 'btn', href: `#/doc/order/new?files=${ids.join(',')}` }, '手動建立訂單')) : null,
        ai.enabled ? h('p', { class: 'muted' }, `本月已判讀 ${ai.used} / ${ai.limit} 份。AI 只負責讀欄位，金額加總由系統計算，讀完一定先是草稿，要你確認才入帳。`) : null);
    } catch (e) { result.replaceChildren(h('div', { class: 'notice err' }, e.message)); }
  }
  input.addEventListener('change', () => send([...input.files]));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); send([...e.dataTransfer.files]); });
  mount(shell('upload', h('h1', {}, '上傳單據'), cid() ? [zone, input, result] : needCompany()));
}

// ---------- 待確認 ----------
async function pendingView() {
  mount(shell('pending', h('h1', {}, '待確認'), h('p', { class: 'muted' }, '載入中…')));
  if (!cid()) return mount(shell('pending', h('h1', {}, '待確認'), needCompany()));
  const data = await api('GET', `/api/c/${cid()}/pending`);
  const row = (kind, d) => h('tr', { class: 'click', onclick: () => { location.hash = `#/doc/${kind}/${d.id}`; } },
    h('td', {}, kind === 'purchase' ? '進貨' : '訂單'), h('td', {}, d.doc_date ?? '（未填）'),
    h('td', {}, kind === 'purchase' ? `${nameOf('vendors', d.vendor_id)} ${d.vendor_doc_no}` : `${nameOf('customers', d.customer_id)} ${d.sales_no}`),
    h('td', { class: 'num' }, money(d.total_amount)), h('td', {}, h('span', { class: 'tag warn' }, '草稿')));
  const rows = [...data.purchases.map((d) => row('purchase', d)), ...data.orders.map((d) => row('order', d))];
  mount(shell('pending', h('h1', {}, '待確認'),
    rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['類型', '單據日期', '廠商或客戶與單號', '合計', '狀態'].map((t) => h('th', {}, t)))), h('tbody', {}, rows)) : h('p', { class: 'muted' }, '沒有待確認的單據。'),
    data.files.length ? [h('h2', {}, `還沒建立單據的照片（${data.files.length}）`),
      h('p', {}, h('a', { class: 'btn', href: `#/doc/purchase/new?files=${data.files.map((f) => f.id).join(',')}` }, '用這些照片建立進貨單'), ' ',
        h('a', { class: 'btn', href: `#/doc/order/new?files=${data.files.map((f) => f.id).join(',')}` }, '建立訂單'))] : null));
}

// ---------- 清單頁 ----------
async function listView(kind) {
  const isPurchase = kind === 'purchase';
  const q = { status: '', q: '', from: '', to: '', party: '' };
  const body = h('div', {});
  const title = isPurchase ? '進貨' : '訂單';
  async function load() {
    if (!cid()) return body.replaceChildren(needCompany());
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status: q.status, q: q.q, from: q.from, to: q.to, [isPurchase ? 'vendor_id' : 'customer_id']: q.party })) if (v) p.set(k, v);
    body.replaceChildren(h('p', { class: 'muted' }, '載入中…'));
    const { rows, total } = await api('GET', `/api/c/${cid()}/${isPurchase ? 'purchases' : 'orders'}?${p}`);
    body.replaceChildren(
      h('p', { class: 'muted' }, `共 ${total} 筆`),
      h('table', {}, h('thead', {}, h('tr', {}, ['單據日期', isPurchase ? '廠商' : '客戶', isPurchase ? '類型與單號' : '銷貨單號', '合計', '狀態'].map((t, i) => h('th', { class: i === 3 ? 'num' : '' }, t)))),
        h('tbody', {}, rows.map((d) => h('tr', { class: 'click', onclick: () => { location.hash = `#/doc/${kind}/${d.id}`; } },
          h('td', {}, d.doc_date ?? '（未填）'), h('td', {}, isPurchase ? nameOf('vendors', d.vendor_id) : nameOf('customers', d.customer_id)),
          h('td', {}, isPurchase ? `${DOC_TYPES[d.doc_type]} ${d.vendor_doc_no}` : d.sales_no), h('td', { class: 'num' }, money(d.total_amount)),
          h('td', {}, h('span', { class: `tag ${d.status === 'confirmed' ? 'ok' : 'warn'}` }, d.status === 'confirmed' ? '已入帳' : '草稿')))))));
  }
  const field = (label, el) => h('label', { class: 'field' }, label, el);
  const parties = isPurchase ? state.masters.vendors : state.masters.customers;
  const bar = h('div', { class: 'bar' },
    field('關鍵字（單號、品名、備註）', h('input', { oninput: (e) => { q.q = e.target.value; clearTimeout(bar.t); bar.t = setTimeout(load, 300); } })),
    field(isPurchase ? '廠商' : '客戶', h('select', { onchange: (e) => { q.party = e.target.value; load(); } }, h('option', { value: '' }, '全部'), parties.map((v) => h('option', { value: v.id }, v.name)))),
    field('狀態', h('select', { onchange: (e) => { q.status = e.target.value; load(); } }, h('option', { value: '' }, '全部'), h('option', { value: 'draft' }, '草稿'), h('option', { value: 'confirmed' }, '已入帳'))),
    field('日期（起）', h('input', { type: 'date', onchange: (e) => { q.from = e.target.value; load(); } })),
    field('日期（迄）', h('input', { type: 'date', onchange: (e) => { q.to = e.target.value; load(); } })),
    h('a', { class: 'btn primary', href: `#/doc/${kind}/new` }, `新增${title}單`));
  mount(shell(isPurchase ? 'purchases' : 'orders', h('h1', {}, title), bar, body));
  load();
}

// ---------- 判讀確認頁（單據編輯）----------
async function docView(kind, id, query) {
  const isPurchase = kind === 'purchase';
  let doc;
  if (id === 'new') {
    doc = { status: 'draft', doc_type: 'shipment', tax_mode: 'unknown', items: [], files: [], flags: '{}', vendor_id: '', customer_id: '', doc_date: null };
    const fileIds = (query.get('files') ?? '').split(',').filter(Boolean);
    doc.files = fileIds.map((fid) => ({ id: fid }));
  } else doc = await api('GET', `/api/c/${cid()}/${isPurchase ? 'purchases' : 'orders'}/${id}`);
  const readonly = doc.status === 'confirmed';
  const flags = JSON.parse(doc.flags || '{}');
  const items = doc.items.map((i) => ({ ...i, flagsObj: JSON.parse(i.flags || '{}') }));
  if (!items.length && !readonly) items.push({ line_type: 'product', raw_name: '', flagsObj: {} });
  const notice = h('div', {});
  const totalEl = h('strong', { class: 'num' }, '');
  const itemsBody = h('tbody', {});
  const form = { ...doc };

  const input = (opts) => {
    const { get, set, flagKey, flagStore, ...attrs } = opts;
    const el = h('input', { ...attrs, value: get() ?? '', disabled: readonly, class: [attrs.class, flagStore[flagKey] ? 'flag' : ''].filter(Boolean).join(' ') });
    el.addEventListener('input', () => { set(el.value); if (flagStore[flagKey]) { delete flagStore[flagKey]; el.classList.remove('flag'); } recalc(); });
    return el;
  };
  const headerField = (label, key, attrs = {}) => h('label', { class: 'field' }, label, input({ get: () => form[key], set: (v) => { form[key] = v; }, flagKey: key, flagStore: flags, ...attrs }));
  const headerSelect = (label, key, options) => {
    const el = h('select', { disabled: readonly, class: flags[key] ? 'flag' : '' }, options.map(([v, t]) => h('option', { value: v, selected: v === (form[key] ?? '') }, t)));
    el.addEventListener('change', () => { form[key] = el.value; delete flags[key]; el.classList.remove('flag'); });
    return h('label', { class: 'field' }, label, el);
  };

  function recalc() { totalEl.textContent = money(items.reduce((s, i) => s + (Number.isInteger(i.amount) ? i.amount : 0), 0)); }
  function itemRow(it, index) {
    const cell = (cls, el) => h('td', { class: cls }, el);
    const num = (key, parse) => cell('w-num', input({ get: () => it[key], set: (v) => { it[key] = parse(v); }, flagKey: key, flagStore: it.flagsObj, inputmode: 'decimal', class: 'num' }));
    const productSel = h('select', { disabled: readonly, class: 'w-name' }, h('option', { value: '' }, '（未對應商品）'),
      state.masters.products.map((p) => h('option', { value: p.id, selected: p.id === it.product_id }, p.name)));
    if (it.flagsObj.product_id && !readonly) productSel.classList.add('flag');
    productSel.addEventListener('change', () => { it.product_id = productSel.value || null; delete it.flagsObj.product_id; productSel.classList.remove('flag'); });
    const lineSel = h('select', { disabled: readonly }, Object.entries(LINES).map(([v, t]) => h('option', { value: v, selected: v === it.line_type }, t)));
    lineSel.addEventListener('change', () => { it.line_type = lineSel.value; });
    return h('tr', {},
      cell('', lineSel),
      cell('w-name', input({ get: () => it.raw_name, set: (v) => { it.raw_name = v; }, flagKey: 'raw_name', flagStore: it.flagsObj })),
      cell('', productSel),
      ...(isPurchase
        ? [num('cases', toInt), num('packs', toInt)]
        : [num('qty', toInt)]),
      cell('w-num', input({ get: () => it.unit, set: (v) => { it.unit = v; }, flagKey: 'unit', flagStore: it.flagsObj })),
      cell('w-num', input({ get: () => yuan(it.unit_price_x100), set: (v) => { it.unit_price_x100 = toX100(v); }, flagKey: 'unit_price_x100', flagStore: it.flagsObj, inputmode: 'decimal', class: 'num' })),
      num('amount', toInt),
      cell('', readonly ? null : h('button', { class: 'btn small ghost', onclick: () => { items.splice(index, 1); drawItems(); } }, '刪除')));
  }
  function drawItems() { itemsBody.replaceChildren(...items.map(itemRow)); recalc(); }

  // 左側：原始照片
  const viewer = h('div', { class: 'viewer' });
  const stage = h('div', { class: 'stage' });
  const thumbs = h('div', { class: 'thumbs' });
  async function showFile(file, button) {
    thumbs.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
    button?.classList.add('on');
    const { url, mime } = await api('GET', `/api/files/${file.id}/link`);
    if (mime === 'application/pdf') stage.replaceChildren(h('iframe', { src: url, title: '原始單據' }));
    else { const img = h('img', { src: url, alt: '原始單據' }); img.addEventListener('click', () => img.classList.toggle('zoom')); stage.replaceChildren(img); }
  }
  if (doc.files.length) {
    doc.files.forEach((f, i) => { const b = h('button', { onclick: () => showFile(f, b) }, `第 ${i + 1} 頁`); thumbs.append(b); });
    showFile(doc.files[0], thumbs.firstChild).catch((e) => stage.replaceChildren(h('p', { class: 'muted', style: 'padding:12px' }, e.message)));
    viewer.append(stage, thumbs, h('p', { class: 'muted' }, '點圖片可放大。'));
  } else viewer.append(h('div', { class: 'stage' }, h('p', { class: 'muted', style: 'padding:16px' }, '這張單沒有附原始照片（手動輸入）。')));

  const hdr = isPurchase
    ? [headerSelect('廠商', 'vendor_id', [['', '請選擇'], ...state.masters.vendors.map((v) => [v.id, v.name])]),
       headerSelect('單據類型', 'doc_type', Object.entries(DOC_TYPES)),
       headerField('廠商單號', 'vendor_doc_no'),
       headerField('單據日期', 'doc_date', { type: 'date' }),
       headerField('單上原始日期寫法', 'doc_date_raw', { placeholder: '例如 115/11/10' }),
       headerSelect('稅別', 'tax_mode', Object.entries(TAX))]
    : [headerSelect('客戶', 'customer_id', [['', '請選擇'], ...state.masters.customers.map((v) => [v.id, v.name])]),
       headerField('銷貨單號', 'sales_no'), headerField('單據日期', 'doc_date', { type: 'date' }),
       headerField('業務', 'salesperson'), headerField('發票號碼（事後回填）', 'invoice_no')];

  function payload() {
    const clean = (it) => {
      const { flagsObj, id: _id, store_id: _s, purchase_id: _p, order_id: _o, position: _pos, ...rest } = it;
      return { ...rest, flags: flagsObj };
    };
    const body = { ...Object.fromEntries(['vendor_id', 'doc_type', 'vendor_doc_no', 'doc_date', 'doc_date_raw', 'tax_mode', 'customer_id', 'sales_no', 'salesperson', 'invoice_no', 'note'].filter((k) => form[k] !== undefined).map((k) => [k, form[k]])), flags, items: items.map(clean), file_ids: doc.files.map((f) => f.id) };
    if (!body.doc_date) body.doc_date = null;
    return body;
  }
  const base = `/api/c/${cid()}/${isPurchase ? 'purchases' : 'orders'}`;
  const showError = (e) => {
    const fields = e.data?.fields ? Object.entries(e.data.fields).map(([k, v]) => `${k}：${v}`).join('；') : '';
    notice.replaceChildren(h('div', { class: 'notice err' }, e.message + (fields ? `（${fields}）` : '')));
    if (e.data?.duplicates?.length) notice.append(h('div', { class: 'notice warn' }, `已有相同單號的單據（${e.data.duplicates.map((d) => d.doc_date ?? '無日期').join('、')}）。`,
      h('button', { class: 'btn small', style: 'margin-left:10px', onclick: () => finish(true) }, '確認不是重複，仍要入帳')));
  };
  async function save() {
    const body = payload();
    if (id === 'new') { const r = await api('POST', base, body); id = r.id; history.replaceState(null, '', `#/doc/${kind}/${id}`); } else await api('PUT', `${base}/${id}`, body);
    return id;
  }
  async function finish(acknowledge = false) {
    try { await save(); await api('POST', `${base}/${id}/confirm`, { acknowledge_duplicate: acknowledge }); location.hash = `#/${isPurchase ? 'purchases' : 'orders'}`; } catch (e) { showError(e); }
  }
  const anyFlag = () => Object.keys(flags).length || items.some((i) => Object.keys(i.flagsObj).length);
  const buttons = readonly
    ? [h('span', { class: 'tag ok' }, `已入帳 ${doc.confirmed_at?.slice(0, 16).replace('T', ' ')}（UTC）`), h('a', { class: 'btn', href: `#/${isPurchase ? 'purchases' : 'orders'}` }, '返回清單')]
    : [h('button', { class: 'btn', onclick: async () => { try { await save(); notice.replaceChildren(h('div', { class: 'notice' }, '草稿已儲存。')); } catch (e) { showError(e); } } }, '儲存草稿'),
       h('button', { class: 'btn', onclick: () => { for (const k of Object.keys(flags)) delete flags[k]; items.forEach((i) => { i.flagsObj = {}; }); document.querySelectorAll('.flag').forEach((el) => el.classList.remove('flag')); } }, '這些都沒錯'),
       h('button', { class: 'btn primary', onclick: () => { if (anyFlag()) notice.replaceChildren(h('div', { class: 'notice warn' }, '還有標黃的欄位，請修正，或按「這些都沒錯」。')); else finish(); } }, '確認入帳')];

  function render() {
    const head = isPurchase
      ? ['類型', '品名（單上寫法）', '對應商品', '箱數', '包數', '單位', '單價（元）', '金額（元）', '']
      : ['類型', '品名（單上寫法）', '對應商品', '數量', '單位', '單價（元）', '金額（元）', ''];
    const form2 = h('div', {},
      readonly ? h('div', { class: 'notice' }, '這張單已確認入帳，不能再修改。') : null,
      !readonly && (form.note ?? '').startsWith('【判讀提醒】') ? h('div', { class: 'notice warn' }, 'AI 讀完這張單據，請對照左邊照片檢查標黃的欄位。', h('br'), form.note) : null,
      h('div', { class: 'grid' }, ...hdr),
      h('h2', {}, '品項'),
      h('div', { style: 'overflow-x:auto' }, h('table', { class: 'items' }, h('thead', {}, h('tr', {}, head.map((t) => h('th', {}, t)))), itemsBody)),
      readonly ? null : h('p', {}, h('button', { class: 'btn small', onclick: () => { items.push({ line_type: 'product', raw_name: '', flagsObj: {} }); drawItems(); } }, '新增一行')),
      h('p', {}, '合計（元）：', totalEl, h('span', { class: 'muted' }, '　由程式加總，金額留空的行不計入')),
      h('label', { class: 'field' }, '備註', h('textarea', { rows: 2, disabled: readonly, oninput: (e) => { form.note = e.target.value; } }, form.note ?? '')),
      notice, h('div', { class: 'actions' }, ...buttons));
    mount(shell(isPurchase ? 'purchases' : 'orders', h('h1', {}, `${isPurchase ? '進貨單' : '訂單'}${id === 'new' ? '（新增）' : ''}`), h('div', { class: 'split' }, viewer, form2)));
    drawItems();
  }
  render();
}

// ---------- 設定 ----------
const SETTINGS = {
  companies: { label: '買方公司', cols: [['name', '名稱'], ['tax_id', '統編']], fields: [['name', '名稱'], ['tax_id', '統編（8 碼，選填）'], ['aliases', '單上的其他名稱（用頓號分隔，選填）', 'list']] },
  vendors: { label: '廠商', cols: [['name', '名稱'], ['tax_id', '統編'], ['category', '類別']], fields: [['name', '名稱'], ['tax_id', '統編（8 碼，選填；填了 AI 判讀會更準）'], ['aliases', '單上的其他名稱（用頓號分隔，選填）', 'list'], ['category', '類別', 'category']] },
  products: { label: '商品', cols: [['sku', '品號'], ['name', '品名'], ['unit', '單位'], ['pack_per_case', '每箱包數']], fields: [['sku', '品號'], ['name', '品名'], ['unit', '單位'], ['pack_per_case', '每箱包數', 'int']] },
  customers: { label: '客戶', cols: [['code', '代號'], ['name', '名稱']], fields: [['code', '客戶代號'], ['name', '名稱'], ['aliases', '單上的其他名稱（用頓號分隔，選填）', 'list']] },
  aliases: { label: '品名對照', cols: [['vendor_id', '廠商', 'vendor'], ['raw_name', '單上寫法'], ['product_id', '對應商品', 'product']], fields: [['vendor_id', '廠商', 'vendor'], ['raw_name', '單上寫法'], ['product_id', '對應商品', 'product']] },
};
async function settingsView(tab = 'companies') {
  const cfg = SETTINGS[tab] ?? SETTINGS.companies;
  mount(shell('settings', h('h1', {}, '設定'), h('p', { class: 'muted' }, '載入中…')));
  const { rows } = await api('GET', `/api/master/${tab}`);
  const owner = state.me.user.role === 'owner';
  const msg = h('div', {});
  const draft = {};
  const display = (row, [key, , kind]) => (kind === 'vendor' ? nameOf('vendors', row[key]) : kind === 'product' ? nameOf('products', row[key]) : key === 'category' ? (CATEGORIES[row[key]] ?? '') : (row[key] ?? ''));
  const formInput = ([key, label, kind]) => {
    let el;
    if (kind === 'category') el = h('select', {}, h('option', { value: '' }, '請選擇'), Object.entries(CATEGORIES).map(([v, t]) => h('option', { value: v }, t)));
    else if (kind === 'vendor') el = h('select', {}, h('option', { value: '' }, '請選擇'), state.masters.vendors.map((v) => h('option', { value: v.id }, v.name)));
    else if (kind === 'product') el = h('select', {}, h('option', { value: '' }, '請選擇'), state.masters.products.map((v) => h('option', { value: v.id }, v.name)));
    else el = h('input', {});
    const read = () => (kind === 'int' ? (el.value === '' ? null : Number(el.value)) : kind === 'list' ? el.value.split(/[、,，]/).map((x) => x.trim()).filter(Boolean) : el.value);
    el.addEventListener('input', () => { draft[key] = read(); });
    el.addEventListener('change', () => { draft[key] = read(); });
    return h('label', { class: 'field' }, label, el);
  };
  const tabs = h('p', {}, Object.entries(SETTINGS).map(([k, v]) => h('a', { class: `btn small ${k === tab ? 'primary' : ''}`, href: `#/settings/${k}`, style: 'margin-right:6px' }, v.label)));
  const themeBox = owner ? h('div', { class: 'card', style: 'margin-top:24px;max-width:420px' }, h('h2', { style: 'margin-top:0' }, '主題色'),
    h('p', { class: 'muted' }, '只會改按鈕與點綴色，版面不變。'),
    (() => {
      const picker = h('input', { type: 'color', value: state.me.store.theme_color ?? '#3e5c76', style: 'width:64px;padding:2px' });
      const save = async (color) => { try { await api('PATCH', '/api/store/theme', { theme_color: color }); state.me.store.theme_color = color; applyTheme(color); msg.replaceChildren(h('div', { class: 'notice' }, color ? '已更新主題色。' : '已還原預設色。')); } catch (e) { msg.replaceChildren(h('div', { class: 'notice err' }, e.message)); } };
      return h('div', { class: 'bar', style: 'margin:0' }, picker, h('button', { class: 'btn', onclick: () => save(picker.value.toLowerCase()) }, '套用'), h('button', { class: 'btn ghost', onclick: () => save(null) }, '還原預設'));
    })()) : null;
  mount(shell('settings', h('h1', {}, '設定'), tabs, msg,
    h('table', {}, h('thead', {}, h('tr', {}, [...cfg.cols.map(([, t]) => h('th', {}, t)), h('th', {}, '狀態')])),
      h('tbody', {}, rows.map((r) => h('tr', {}, ...cfg.cols.map((c) => h('td', {}, display(r, c))), h('td', {}, r.active === 0 ? h('span', { class: 'tag' }, '停用') : ''))))),
    owner ? h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', { style: 'margin-top:0' }, `新增${cfg.label}`), h('div', { class: 'grid' }, ...cfg.fields.map(formInput)),
      h('p', {}, h('button', { class: 'btn primary', onclick: async () => {
        try { await api('POST', `/api/master/${tab}`, draft); if (tab === 'companies') { state.me = await api('GET', '/api/me'); pickCompany(); } await loadMasters(); route(); } catch (e) { msg.replaceChildren(h('div', { class: 'notice err' }, e.message + (e.data?.fields ? `（${Object.values(e.data.fields).join('、')}）` : ''))); }
      } }, '新增'))) : h('p', { class: 'muted' }, '只有負責人可以新增或修改設定。'),
    themeBox));
}

// ---------- 路由 ----------
async function route() {
  try {
    const [path, qs] = (location.hash.slice(1) || '/upload').split('?');
    const [, page, a, b] = path.split('/');
    const query = new URLSearchParams(qs ?? '');
    if (page === 'upload') return uploadView();
    if (page === 'pending') return await pendingView();
    if (page === 'purchases') return await listView('purchase');
    if (page === 'orders') return await listView('order');
    if (page === 'doc') { if (!cid()) return mount(shell('upload', needCompany())); return await docView(a, b, query); }
    if (page === 'settings') return await settingsView(a);
    location.hash = '#/upload';
  } catch (e) { mount(shell('upload', h('div', { class: 'notice err' }, e.message))); }
}

async function start() {
  try { state.me = await api('GET', '/api/me'); } catch (e) { if (e.status === 401) return loginView(); throw e; }
  applyTheme(state.me.store.theme_color);
  pickCompany();
  await loadMasters();
  window.addEventListener('hashchange', route);
  route();
}
start().catch((e) => { $app.textContent = `載入失敗：${e.message}`; });
