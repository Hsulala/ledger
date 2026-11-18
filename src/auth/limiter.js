// 登入失敗限流：同一個 key 15 分鐘內失敗 10 次，封鎖 5 分鐘。存在資料庫，所以多個 isolate 共用同一份計數。
const MAX = 10, WINDOW_MS = 15 * 60_000, BLOCK_MS = 5 * 60_000;

export async function blockedMs(db, key, now = Date.now()) {
  const row = await db.system.getFailure(key);
  return row && row.blocked_until > now ? row.blocked_until - now : 0;
}

export async function recordFailure(db, key, now = Date.now()) {
  const row = await db.system.getFailure(key);
  const fresh = !row || now - row.first_at > WINDOW_MS;
  const count = fresh ? 1 : row.count + 1;
  await db.system.putFailure(key, { count, firstAt: fresh ? now : row.first_at, blockedUntil: count >= MAX ? now + BLOCK_MS : 0 });
}

export const clearFailures = (db, key) => db.system.clearFailure(key);
