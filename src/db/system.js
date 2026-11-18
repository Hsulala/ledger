// 系統層資料（店家本身、帳號、登入階段、限流）。這些資料不屬於任何一家店的「業務資料」，所以不走 scope；
// 但每個函式都是具名、固定 SQL，不開放任意查詢。

import { uuid, nowIso } from '../util.js';

export function createSystem(d1) {
  const q = (sql, ...params) => d1.prepare(sql).bind(...params.map((v) => (v === undefined ? null : v)));
  const all = async (sql, ...params) => (await q(sql, ...params).all()).results;
  const one = async (sql, ...params) => (await q(sql, ...params).first()) ?? null;

  return {
    // 店家
    getStore: (id) => one('SELECT * FROM stores WHERE id = ?', id),
    listStores: () => all('SELECT * FROM stores ORDER BY created_at'),
    async createStore({ id, name, themeColor = null }) {
      const t = nowIso();
      await q('INSERT INTO stores (id, name, theme_color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, name, themeColor, t, t).run();
    },
    async updateStore(id, { name, status, themeColor }) {
      const sets = [], params = [];
      if (name !== undefined) { sets.push('name = ?'); params.push(name); }
      if (status !== undefined) { sets.push('status = ?'); params.push(status); }
      if (themeColor !== undefined) { sets.push('theme_color = ?'); params.push(themeColor); }
      if (!sets.length) return 0;
      const res = await q(`UPDATE stores SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id).run();
      return Number(res.meta.changes);
    },
    getModuleRows: (storeId) => all('SELECT module_key, enabled FROM store_modules WHERE store_id = ?', storeId),
    async setModules(storeId, changes) {
      const t = nowIso();
      await d1.batch(Object.entries(changes).map(([key, enabled]) =>
        q(`INSERT INTO store_modules (store_id, module_key, enabled, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (store_id, module_key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`, storeId, key, enabled ? 1 : 0, t)));
    },
    async audit(storeId, { actorKind, userId = null, action, entity, entityId = null, detail = {} }) {
      await q('INSERT INTO audit_log (id, store_id, user_id, actor_kind, action, entity, entity_id, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        uuid(), storeId, userId, actorKind, action, entity, entityId, JSON.stringify(detail), nowIso()).run();
    },

    // 後台管理者
    countAdmins: async () => Number((await one('SELECT COUNT(*) AS n FROM admin_users')).n),
    getAdminByName: (username) => one('SELECT * FROM admin_users WHERE username = ?', username),
    async createAdmin(username, passwordHash) {
      const id = uuid();
      await q('INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)', id, username, passwordHash, nowIso()).run();
      return id;
    },

    // 店家使用者與綁定連結
    getUser: (id) => one('SELECT * FROM store_users WHERE id = ?', id),
    listUsers: (storeId) => all('SELECT id, display_name, role, status, line_user_id IS NOT NULL AS bound, created_at FROM store_users WHERE store_id = ? ORDER BY created_at', storeId),
    findUsersByLine: (lineUserId) => all(
      `SELECT u.* FROM store_users u JOIN stores s ON s.id = u.store_id
       WHERE u.line_user_id = ? AND u.status = 'active' AND s.status = 'active' ORDER BY u.created_at DESC`, lineUserId),
    async createUserWithInvite({ storeId, displayName, role, tokenHash, expiresAt }) {
      const userId = uuid(), t = nowIso();
      await d1.batch([
        q('INSERT INTO store_users (id, store_id, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)', userId, storeId, displayName, role, t),
        q('INSERT INTO invites (id, store_id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', uuid(), storeId, userId, tokenHash, expiresAt, t),
      ]);
      return userId;
    },
    getInvite: (tokenHash) => one(
      `SELECT i.*, u.display_name, s.name AS store_name, s.status AS store_status FROM invites i
       JOIN store_users u ON u.id = i.user_id JOIN stores s ON s.id = i.store_id WHERE i.token_hash = ?`, tokenHash),
    // 綁定：連結未用過才成立（兩句同一個交易）；回傳是否成功
    async bindInvite(invite, lineUserId) {
      const t = nowIso();
      const [mark, bind] = await d1.batch([
        q('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?', t, invite.id, t),
        q(`UPDATE store_users SET line_user_id = ? WHERE id = ? AND line_user_id IS NULL
           AND EXISTS (SELECT 1 FROM invites WHERE id = ? AND used_at = ?)`, lineUserId, invite.user_id, invite.id, t),
      ]);
      return Number(mark.meta.changes) === 1 && Number(bind.meta.changes) === 1;
    },

    // 登入階段
    async createSession({ tokenHash, kind, adminId = null, storeId = null, userId = null, expiresAt }) {
      await q('INSERT INTO sessions (token_hash, kind, admin_id, store_id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        tokenHash, kind, adminId, storeId, userId, expiresAt, nowIso()).run();
    },
    getSession: (tokenHash) => one('SELECT * FROM sessions WHERE token_hash = ?', tokenHash),
    async deleteSession(tokenHash) { await q('DELETE FROM sessions WHERE token_hash = ?', tokenHash).run(); },
    async purgeExpiredSessions() { await q('DELETE FROM sessions WHERE expires_at < ?', nowIso()).run(); },

    // LINE 登入 state
    async saveOauthState({ stateHash, nonce, inviteTokenHash, expiresAt }) {
      await q('INSERT INTO oauth_states (state_hash, nonce, invite_token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        stateHash, nonce, inviteTokenHash ?? null, expiresAt, nowIso()).run();
    },
    // 取出並刪除（一次性）
    async takeOauthState(stateHash) {
      const row = await one('SELECT * FROM oauth_states WHERE state_hash = ?', stateHash);
      if (!row) return null;
      const res = await q('DELETE FROM oauth_states WHERE state_hash = ?', stateHash).run();
      if (Number(res.meta.changes) !== 1) return null;
      return row.expires_at > nowIso() ? row : null;
    },

    // 限流
    getFailure: (key) => one('SELECT * FROM login_failures WHERE key = ?', key),
    async putFailure(key, { count, firstAt, blockedUntil }) {
      await q(`INSERT INTO login_failures (key, count, first_at, blocked_until) VALUES (?, ?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET count = excluded.count, first_at = excluded.first_at, blocked_until = excluded.blocked_until`,
      key, count, firstAt, blockedUntil).run();
    },
    async clearFailure(key) { await q('DELETE FROM login_failures WHERE key = ?', key).run(); },
  };
}
