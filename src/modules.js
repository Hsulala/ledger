// 模組代碼 ledger 的子功能。supported:false 表示這一版還沒做，Hub 的對照表會顯示「尚未支援」。
// 新子功能預設關閉；沒有存過設定的店家用 default。
export const MODULES = {
  documentRecognition: { label: '單據判讀', default: false, supported: true },
  purchaseOrders: { label: '進貨訂單', default: true, supported: true },
  vendorReconcile: { label: '廠商對帳', default: false, supported: false },
  customerStatements: { label: '客戶對帳單', default: false, supported: true },
  webQuery: { label: '網頁查詢', default: true, supported: true },
  logisticsExport: { label: '物流匯出', default: false, supported: false },
};
export const MODULE_KEYS = Object.keys(MODULES);

export async function getModules(db, storeId) {
  const stored = Object.fromEntries((await db.system.getModuleRows(storeId)).map((r) => [r.module_key, r.enabled === 1]));
  return Object.fromEntries(MODULE_KEYS.map((key) => [key, {
    label: MODULES[key].label,
    supported: MODULES[key].supported,
    enabled: MODULES[key].supported && (stored[key] ?? MODULES[key].default),
    state: !MODULES[key].supported ? 'unsupported' : (stored[key] ?? MODULES[key].default) ? 'on' : 'off',
  }]));
}
