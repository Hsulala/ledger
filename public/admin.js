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
  const [{ modules }, { users }] = await Promise.all([api('GET', `/api/admin/stores/${store.id}/modules`), api('GET', `/api/admin/stores/${store.id}/users`)]);
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
    h('h2', {}, '使用者'),
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

async function start() {
  try { await api('GET', '/api/admin/stores'); } catch (e) { if (e.status === 401) return loginView(); say(e.message, true); return; }
  dashboard();
}
start();
