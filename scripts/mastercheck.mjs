// 本機檢查鼎新匯出的主檔：node scripts/mastercheck.mjs 檔案1.xlsx 檔案2.xlsx ... [--out 報告.csv]
// 只讀檔、不寫任何資料庫，輸出摘要與清理報告（CSV）。
import readXlsxFile from 'read-excel-file/node';
import { writeFileSync } from 'node:fs';
import { ISSUE_LABELS, NORMALIZERS, detectKind, rowsToObjects } from '../src/import/master.js';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args.splice(outIdx, 2)[1] : '鼎新主檔清理報告.csv';
const LABEL = { vendors: '廠商', products: '商品', customers: '客戶' };
const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const lines = [['種類', '程度', '問題', '代號或品號', '名稱', '說明'].map(cell).join(',')];
for (const file of args) {
  const data = (await readXlsxFile(file))[0].data;
  const kind = detectKind(data[0]);
  if (!kind) { console.log(`略過 ${file}：看不出是哪種主檔`); continue; }
  const { rows, issues } = NORMALIZERS[kind](rowsToObjects(data));
  const check = issues.filter((i) => i.severity === 'check').length;
  console.log(`${LABEL[kind]}：Excel ${data.length - 1} 列，可匯入 ${rows.length}，需確認 ${check}，提示 ${issues.length - check}`);
  for (const i of issues) lines.push([LABEL[kind], i.severity === 'check' ? '需確認' : '提示', ISSUE_LABELS[i.kind] ?? i.kind, i.key, i.name, i.detail].map(cell).join(','));
}
writeFileSync(out, '﻿' + lines.join('\r\n'));
console.log(`清理報告：${out}`);
