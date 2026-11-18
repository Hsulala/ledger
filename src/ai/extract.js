// 呼叫模型讀取單據照片。模型只負責「讀」：照單上印的寫出來，不計算、不修正、不補猜。
// 輸出一律走 tool 的結構化格式，程式再驗證與換算（見 normalize.js、recognize.js）。

import { HttpError } from '../util.js';

export const PROMPT_VERSION = 'v1-2026-11';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 模型對單張圖片的上限

export const DOC_KINDS = ['purchase_delivery', 'sales_order', 'vendor_statement', 'payment_request', 'other'];

const STR = { type: ['string', 'null'] };
const NUM = { type: ['number', 'null'] };
const FIELDS = { type: 'array', items: { type: 'string' } };

export const TOOL = {
  name: 'record_document',
  description: '把單據上印出來的內容原樣記錄下來。不要計算、不要更正、不要猜測看不清楚的字。',
  input_schema: {
    type: 'object',
    required: ['doc_kind', 'items'],
    properties: {
      doc_kind: { type: 'string', enum: DOC_KINDS, description: 'purchase_delivery=廠商出貨單/送貨單/進貨單；sales_order=我方賣給客戶的訂單或銷貨單；vendor_statement=對帳單或帳款明細（多張單據彙總）；payment_request=請款單或請款總表；other=其他' },
      doc_title: { ...STR, description: '單據上的標題字樣，例如 出貨單、送貨單、進貨單、銷貨單、報價單' },
      vendor_name: { ...STR, description: '開立單據的廠商（賣方）名稱，照印的寫' },
      vendor_tax_id: { ...STR, description: '廠商統一編號，8 位數字，沒有就 null' },
      buyer_name: { ...STR, description: '單上的買方或客戶名稱' },
      buyer_tax_id: { ...STR, description: '買方統一編號，沒有就 null' },
      doc_no: { ...STR, description: '單據號碼，照印的寫' },
      date_text: { ...STR, description: '單據日期，完全照單上寫法（如 115/10/01、26.10.01、2026/11/13），不要換算' },
      tax_mode: { type: 'string', enum: ['excl', 'incl', 'exempt', 'unknown'], description: '單上標示：未稅、含稅、免稅，沒標示就 unknown' },
      printed_tax: { ...NUM, description: '單上印出的稅額' },
      printed_total: { ...NUM, description: '單上印出的合計或總計金額（不要自己加總）' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            line_type: { type: 'string', enum: ['product', 'freight', 'gift'], description: '運費記 freight，贈品記 gift，其餘 product' },
            name: { type: 'string', description: '品名，照印的寫' },
            sku: STR,
            cases: { ...NUM, description: '箱數（只有單上有分箱與包時填）' },
            packs: { ...NUM, description: '包數（只有單上有分箱與包時填）' },
            qty: { ...NUM, description: '數量（沒有分箱與包時填）' },
            unit: STR,
            unit_price: { ...NUM, description: '單上印的單價，沒印就 null' },
            amount: { ...NUM, description: '這一行單上印的金額，沒印就 null' },
            uncertain_fields: { ...FIELDS, description: '看不清楚、被遮住或不確定的欄位名稱（name、qty、cases、packs、unit、unit_price、amount）' },
          },
        },
      },
      handwritten_notes: { type: 'array', items: { type: 'string' }, description: '紙上的手寫字（驗算、勾選、備註），原樣抄下。這些只是參考，不是單據資料' },
      uncertain_fields: { ...FIELDS, description: '表頭看不清楚或不確定的欄位名稱（vendor_name、vendor_tax_id、buyer_name、buyer_tax_id、doc_no、date_text、printed_total）' },
      notes: { ...STR, description: '其他需要人看的提醒，例如照片歪斜、頁面被遮住、缺頁' },
    },
  },
};

export const SYSTEM_PROMPT = `你是單據讀取助手，只負責把照片或 PDF 裡印出來的內容抄成結構化資料。
規則：
1. 只寫看得到的字。看不清楚、被遮住、模糊的欄位填 null，並把欄位名稱列入 uncertain_fields，不要猜。
2. 不要計算。不要加總、不要換算日期、不要重新算金額；單上印什麼就寫什麼。
3. 手寫的驗算、勾選、備註不是單據資料，只放進 handwritten_notes。
4. 多張圖片是同一份單據的不同頁，合併成一份輸出。
5. 日期完全照單上寫法放進 date_text。
6. 先判斷 doc_kind：單筆出貨或送貨單為 purchase_delivery；彙總多張單據的對帳單為 vendor_statement；請款單或請款總表為 payment_request。`;

// 分段轉 base64，避免大檔一次展開造成呼叫堆疊過深
export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export async function callModel({ env, fetchImpl = fetch, files }) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, '尚未設定 AI 金鑰（ANTHROPIC_API_KEY）');
  const model = env.AI_MODEL || DEFAULT_MODEL;
  const content = [];
  for (const f of files) {
    if (f.mime === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(f.bytes) } });
    else content.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: toBase64(f.bytes) } });
  }
  content.push({ type: 'text', text: '請讀取這份單據，呼叫 record_document 記錄。' });
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 8000, system: SYSTEM_PROMPT, tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name }, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new HttpError(502, res.status === 429 ? 'AI 目前忙碌，請稍後再試' : 'AI 判讀失敗，請稍後再試', { upstream: res.status });
  const data = await res.json();
  const block = (data.content ?? []).find((b) => b.type === 'tool_use' && b.name === TOOL.name);
  if (!block || typeof block.input !== 'object') throw new HttpError(502, 'AI 沒有回傳可用的結果');
  return { output: block.input, model, usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 } };
}
