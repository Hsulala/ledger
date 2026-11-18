// 資料庫唯一入口。env.DB（D1 binding）只在這個資料夾內使用。
import { createScope } from './scope.js';
import { createSystem } from './system.js';

export function getDb(env) {
  const d1 = env.DB;
  if (!d1) throw new Error('沒有設定 D1 binding：DB');
  return {
    system: createSystem(d1),
    scope: (storeId, companyId = null) => createScope(d1, { storeId, companyId }),
  };
}
