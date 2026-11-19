// 帳房後台（管理者）：建立店家、主題色、子功能開關、建立使用者與綁定連結。
const $app = document.getElementById('app');
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `錯誤 ${res.status}`); e.status = res.status; throw e; }
  return data;
}
const msg = h('div', {});
const say = (text, err) => msg.replaceChildren(h('div', { class: `notice ${err ? 'err' : ''}` }, text));
let selected = null;

function loginView() {
  const user = h('input', { placeholder: '帳號', autocomplete: 'username' }), pass = h('input', { type: 'password', placeholder: '密碼', autocomplete: 'current-password' });
  const go = async () => { try { await api('POST', '/api/admin/login', { username: user.value, password: pass.value }); start(); } catch (e) { say(e.message, true); } };
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $app.replaceChildren(h('div', { class: 'center' }, h('h1', {}, '帳房後台'), msg, h('p', {}, user), h('p', {}, pass), h('button', { class: 'btn primary', onclick: go }, '登入')));
}

async function dashboard() {
  const { stores } = await api('GET', '/api/admin/stores');
  const id = h('input', { placeholder: '店家代號（小寫英數，例如 mamie）' }), name = h('input', { placeholder: '店家名稱' });
  const create = h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, '新增店家'), h('div', { class: 'grid' }, id, name),
    h('p', {}, h('button', { class: 'btn primary', onclick: async () => { try { await api('POST', '/api/admin/stores', { id: id.value, name: name.value }); selected = id.value; dashboard(); } catch (e) { say(e.message, true); } } }, '建立')));
  const detail = h('div', {});
  $app.replaceChildren(h('main', {}, h('h1', {}, '帳房後台'), msg,
    h('table', {}, h('thead', {}, h('tr', {}, ['代號', '名稱', '狀態', '主題色', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, stores.map((s) => h('tr', { class: 'click', onclick: () => { selected = s.id; showStore(detail, s); } },
        h('td', {}, s.id), h('td', {}, s.name), h('td', {}, s.status), h('td', {}, s.theme_color ?? '預設'), h('td', {}, selected === s.id ? '◆' : ''))))),
    detail, h('div', { style: 'margin-top:24px' }, create)));
  const current = stores.find((s) => s.id === selected);
  if (current) showStore(detail, current);
}

async function showStore(box, store) {
  const [{ modules }, { users }, ai] = await Promise.all([api('GET', `/api/admin/stores/${store.id}/modules`), api('GET', `/api/admin/stores/${store.id}/users`), api('GET', `/api/admin/stores/${store.id}/ai`)]);
  const limitInput = h('input', { type: 'number', min: 0, max: 100000, value: ai.limit, style: 'width:100px' });
  const aiBox = h('div', { class: 'bar' }, h('span', {}, `本月已判讀 ${ai.used} 份，每月上限`), limitInput, h('span', {}, '份'),
    h('button', { class: 'btn', onclick: async () => { try { await api('PUT', `/api/admin/stores/${store.id}/ai`, { limit: Number(limitInput.value) }); say('已更新每月上限'); } catch (e) { say(e.message, true); } } }, '儲存'),
    h('span', { class: 'muted' }, `（預設 ${ai.default_limit}；到上限後該店不能再用 AI 判讀。要使用還需在上面開啟「單據判讀」）`));
  const color = h('input', { type: 'color', value: store.theme_color ?? '#3e5c76', style: 'width:64px;padding:2px' });
  const statusSel = h('select', { style: 'width:auto' }, ['active', 'paused', 'ended'].map((v) => h('option', { value: v, selected: v === store.status }, { active: '啟用', paused: '暫停', ended: '結束' }[v])));
  const linkBox = h('div', {});
  const userName = h('input', { placeholder: '使用者名稱，例如 Mamie' });
  const role = h('select', { style: 'width:auto' }, h('option', { value: 'owner' }, '負責人'), h('option', { value: 'staff' }, '一般使用者'));
  box.replaceChildren(h('h2', {}, `${store.name}（${store.id}）`),
    h('div', { class: 'card' }, h('div', { class: 'bar', style: 'margin:0' }, h('label', { class: 'field' }, '主題色', color),
      h('button', { class: 'btn', onclick: async () => { try { await api('PATCH', `/api/admin/stores/${store.id}`, { theme_color: color.value.toLowerCase() }); say('已更新主題色'); } catch (e) { say(e.message, true); } } }, '套用主題色'),
      h('label', { class: 'field' }, '店家狀態', statusSel),
      h('button', { class: 'btn', onclick: async () => { try { await api('PATCH', `/api/admin/stores/${store.id}`, { status: statusSel.value }); say('已更新狀態'); dashboard(); } catch (e) { say(e.message, true); } } }, '更新狀態'))),
    h('h2', {}, '子功能'),
    h('table', {}, h('thead', {}, h('tr', {}, ['子功能', '狀態'].map((t) => h('th', {}, t)))),
      h('tbody', {}, Object.entries(modules).map(([key, m]) => h('tr', {}, h('td', {}, m.label),
        h('td', {}, m.state === 'unsupported' ? h('span', { class: 'tag' }, '尚未支援') : h('label', {}, h('input', { type: 'checkbox', checked: m.enabled, onchange: async (e) => { try { await api('PUT', `/api/admin/stores/${store.id}/modules`, { modules: { [key]: e.target.checked } }); say(`${m.label}：${e.target.checked ? '已開啟' : '已關閉'}`); } catch (err) { say(err.message, true); e.target.checked = !e.target.checked; } } }), ' 開啟')))))),
    h('h2', {}, '單據判讀（AI）'),
    aiBox,
    h('h2', {}, '匯入鼎新主檔'),
    h('p', { class: 'muted' }, '選擇從鼎新匯出的商品、客戶、廠商 Excel。先預覽並下載清理報告，確認後才寫入。'),
    importBox(store),
    h('h2', {}, '使用者'),
    h('p', {}, h('button', { class: 'btn', onclick: async () => {
      try { await api('POST', `/api/admin/stores/${store.id}/preview`, {}); window.open('/', '_blank'); say('已開啟店家端預覽（2 小時有效）。預覽中的操作會以該店負責人名義記錄。'); } catch (e) { say(e.message, true); }
    } }, '以店家負責人身分預覽'), h('span', { class: 'muted' }, '　不需要 LINE，預覽中輸入的資料是真實資料')),
    h('table', {}, h('thead', {}, h('tr', {}, ['名稱', '角色', 'LINE 綁定', '狀態'].map((t) => h('th', {}, t)))),
      h('tbody', {}, users.map((u) => h('tr', {}, h('td', {}, u.display_name), h('td', {}, u.role === 'owner' ? '負責人' : '一般使用者'), h('td', {}, u.bound ? '已綁定' : '尚未綁定'), h('td', {}, u.status))))),
    h('div', { class: 'bar', style: 'margin-top:12px' }, userName, role,
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = await api('POST', `/api/admin/stores/${store.id}/users`, { display_name: userName.value, role: role.value });
          linkBox.replaceChildren(h('div', { class: 'notice warn' }, '綁定連結只會顯示這一次，7 天內有效、只能使用一次。請傳給使用者，用手機 LINE 開啟：', h('br'), h('code', { style: 'word-break:break-all' }, r.link)));
        } catch (e) { say(e.message, true); }
      } }, '建立使用者並產生綁定連結')), linkBox);
}


// ---------- 匯入鼎新主檔（商品、客戶、廠商 Excel）----------
const KIND_LABEL = { vendors: '廠商', products: '商品', customers: '客戶' };
const ISSUE_LABEL = {
  vendor_no_name: '廠商沒有名稱', name_too_long: '名稱過長', bad_tax_id: '統編格式不正確', no_tax_id: '沒有統編', dup_vendor_name: '廠商名稱重複',
  product_missing: '商品缺品號或品名', sku_too_long: '品號過長', dup_product_name: '品名重複（不同品號）', no_list_price: '零售價是 0', no_group: '商品沒有分類', dup_sku: '品號重複',
  customer_missing: '客戶缺代號或簡稱', code_too_long: '客戶代號過長', bill_to_other: '請款客戶不是自己', dup_customer_name: '客戶名稱重複（不同代號）', dup_code: '客戶代號重複',
};
function detectKind(headers) {
  const set = new Set(headers.map((x) => String(x ?? '').trim()));
  if (set.has('品號') && set.has('品名')) return 'products';
  if (set.has('客戶代號') && set.has('客戶簡稱')) return 'customers';
  if (set.has('廠商代號') && set.has('廠商簡稱')) return 'vendors';
  return null;
}
function rowsToObjects(sheetRows) {
  const [head, ...body] = sheetRows;
  const keys = head.map((x) => String(x ?? '').trim());
  return body.filter((r) => r.some((c) => c !== null && c !== '')).map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? null])));
}
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function downloadReport(reports) {
  const lines = [['種類', '程度', '問題', '代號或品號', '名稱', '說明'].map(csvCell).join(',')];
  for (const r of reports) for (const i of r.issues) lines.push([KIND_LABEL[r.kind], i.severity === 'check' ? '需確認' : '提示', ISSUE_LABEL[i.kind] ?? i.kind, i.key, i.name, i.detail].map(csvCell).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `鼎新主檔清理報告.csv` });
  document.body.append(a); a.click(); a.remove();
}
function importBox(store) {
  const files = h('input', { type: 'file', accept: '.xlsx', multiple: true });
  const out = h('div', {});
  let loaded = []; // [{ kind, rows }]
  let reports = [];
  const draw = (committed) => {
    out.replaceChildren(
      h('table', {}, h('thead', {}, h('tr', {}, ['種類', 'Excel 列數', '可匯入', '將新增', '已存在略過', '需確認', '提示'].map((t) => h('th', {}, t)))),
        h('tbody', {}, reports.map((r) => h('tr', {}, h('td', {}, KIND_LABEL[r.kind]), h('td', { class: 'num' }, r.total), h('td', { class: 'num' }, r.importable), h('td', { class: 'num' }, committed ? `${r.new}（已寫入）` : r.new), h('td', { class: 'num' }, r.existing),
          h('td', { class: 'num' }, r.issues.filter((i) => i.severity === 'check').length), h('td', { class: 'num' }, r.issues.filter((i) => i.severity === 'info').length))))),
      h('div', { class: 'bar' }, h('button', { class: 'btn', onclick: () => downloadReport(reports) }, '下載清理報告（CSV）'),
        committed ? null : h('button', { class: 'btn primary', onclick: commit }, '確認匯入'),
        h('span', { class: 'muted' }, committed ? '已匯入完成。' : '預覽不會寫入資料；已存在的資料不會被覆蓋，庫存量與標準進價不匯入。')));
  };
  async function preview() {
    try {
      const picked = [...files.files];
      if (!picked.length) { say('請先選擇 Excel 檔（商品、客戶、廠商資料，可一次選多個）', true); return; }
      const { default: readXlsxFile } = await import('/readxlsx.js').then((m) => ({ default: m.readXlsxFile }));
      loaded = [];
      for (const f of picked) {
        const sheets = await readXlsxFile(f);
        const data = sheets[0]?.data ?? [];
        const kind = data.length ? detectKind(data[0]) : null;
        if (!kind) { say(`看不出「${f.name}」是商品、客戶還是廠商資料（找不到品號／客戶代號／廠商代號欄）`, true); return; }
        loaded.push({ kind, rows: rowsToObjects(data) });
      }
      reports = [];
      for (const l of loaded) reports.push(await api('POST', `/api/admin/stores/${store.id}/import/${l.kind}`, { rows: l.rows, commit: false }));
      say('預覽完成，請先下載清理報告檢查，沒問題再按「確認匯入」。');
      draw(false);
    } catch (e) { say(e.message, true); }
  }
  async function commit() {
    if (!confirm('確認把這些資料匯入？已存在的不會被覆蓋。')) return;
    try {
      reports = [];
      for (const l of loaded) reports.push(await api('POST', `/api/admin/stores/${store.id}/import/${l.kind}`, { rows: l.rows, commit: true }));
      say('匯入完成。');
      draw(true);
    } catch (e) { say(e.message, true); }
  }
  return h('div', {}, h('div', { class: 'bar' }, files, h('button', { class: 'btn', onclick: preview }, '讀取並預覽')), out);
}

async function start() {
  try { await api('GET', '/api/admin/stores'); } catch (e) { if (e.status === 401) return loginView(); say(e.message, true); return; }
  dashboard();
}
start();
