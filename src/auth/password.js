// 密碼雜湊：PBKDF2-SHA256（Workers 的 WebCrypto 上限是 10 萬次）。格式 pbkdf2$次數$salt$hash（base64url）。
import { b64url, fromB64url, safeEqual } from '../util.js';

const ITERATIONS = 100_000;
const enc = new TextEncoder();

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64url(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('密碼至少 8 個字元');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${await derive(password, salt, ITERATIONS)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2' || !iterations || !salt || !hash) return false;
  return safeEqual(await derive(String(password), fromB64url(salt), Number(iterations)), hash);
}
