"use strict";

/*
 * 書き出しデータの暗号化（ブラウザ標準の Web Crypto のみ。外部ライブラリなし）。
 *  - 鍵の導出: PBKDF2-SHA256（既定 600,000 回）+ ランダムなsalt（16バイト）
 *  - 暗号化: AES-256-GCM + ランダムなiv（12バイト）。改ざんされると復号に失敗する
 *  - パスフレーズは保存も送信もしない
 */
(function (root) {
  const FORMAT = "decision-journal-encrypted";
  const DEFAULT_ITER = 600000;
  const MIN_ITER = 100000;
  const MAX_ITER = 2000000; // 悪意あるファイルで計算を止められないようにする上限
  const MIN_PASS = 8;

  const te = new TextEncoder();
  const td = new TextDecoder();

  const getSubtle = () => {
    if (typeof crypto === "undefined" || !crypto.subtle) throw new Error("unsupported");
    return crypto.subtle;
  };

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function fromB64(str, expectedLen) {
    if (typeof str !== "string" || str.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(str) || str.length > 4 * 1024 * 1024) throw new Error("format");
    let bin;
    try { bin = atob(str); } catch (_) { throw new Error("format"); }
    if (expectedLen && bin.length !== expectedLen) throw new Error("format");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveKey(passphrase, salt, iterations) {
    const subtle = getSubtle();
    const base = await subtle.importKey("raw", te.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }

  const isEncrypted = (obj) => !!obj && typeof obj === "object" && obj.format === FORMAT;

  async function encrypt(data, passphrase, iterations) {
    if (typeof passphrase !== "string" || passphrase.length < MIN_PASS) throw new Error("weak-passphrase");
    const iter = iterations || DEFAULT_ITER;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt, iter);
    const ct = await getSubtle().encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(data)));
    return { format: FORMAT, v: 1, kdf: "PBKDF2-SHA256", iter, salt: toB64(salt), iv: toB64(iv), data: toB64(ct) };
  }

  async function decrypt(pkg, passphrase) {
    if (!isEncrypted(pkg) || pkg.v !== 1 || pkg.kdf !== "PBKDF2-SHA256") throw new Error("format");
    const iter = pkg.iter;
    if (!Number.isInteger(iter) || iter < MIN_ITER || iter > MAX_ITER) throw new Error("format");
    const salt = fromB64(pkg.salt, 16);
    const iv = fromB64(pkg.iv, 12);
    const data = fromB64(pkg.data);
    try {
      const key = await deriveKey(String(passphrase), salt, iter);
      const plain = await getSubtle().decrypt({ name: "AES-GCM", iv }, key, data);
      return JSON.parse(td.decode(plain));
    } catch (_) {
      throw new Error("decrypt-failed"); // パスフレーズ違い・改ざんを区別しない
    }
  }

  const api = { FORMAT, DEFAULT_ITER, MIN_PASS, isEncrypted, encrypt, decrypt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.JournalCrypto = api;
})(typeof window !== "undefined" ? window : globalThis);
