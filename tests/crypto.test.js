"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../crypto.js");

const ITER = 100000; // テストを速くするため下限値を使う（既定は600000）
const data = { version: 1, decisions: [{ question: "秘密の判断 😀" }] };

test("暗号化して復号すると元に戻る（日本語・絵文字も）", async () => {
  const pkg = await C.encrypt(data, "correct horse battery", ITER);
  assert.equal(C.isEncrypted(pkg), true);
  assert.equal(pkg.kdf, "PBKDF2-SHA256");
  assert.ok(!JSON.stringify(pkg).includes("秘密"), "平文が含まれない");
  assert.deepEqual(await C.decrypt(pkg, "correct horse battery"), data);
});

test("同じ内容でも、毎回 salt と iv が変わる", async () => {
  const a = await C.encrypt(data, "passphrase-1", ITER);
  const b = await C.encrypt(data, "passphrase-1", ITER);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

test("パスフレーズが違う・改ざんされた場合は、同じ失敗として扱う", async () => {
  const pkg = await C.encrypt(data, "passphrase-1", ITER);
  await assert.rejects(C.decrypt(pkg, "passphrase-2"), /decrypt-failed/);
  const bytes = Buffer.from(pkg.data, "base64");
  bytes[0] ^= 1;
  await assert.rejects(C.decrypt({ ...pkg, data: bytes.toString("base64") }, "passphrase-1"), /decrypt-failed/);
});

test("短いパスフレーズは拒否する", async () => {
  await assert.rejects(C.encrypt(data, "short", ITER), /weak-passphrase/);
});

test("不正な形式・危険な反復回数は、計算を始める前に拒否する", async () => {
  const pkg = await C.encrypt(data, "passphrase-1", ITER);
  await assert.rejects(C.decrypt({ ...pkg, iter: 1e12 }, "passphrase-1"), /format/);
  await assert.rejects(C.decrypt({ ...pkg, iter: 1 }, "passphrase-1"), /format/);
  await assert.rejects(C.decrypt({ ...pkg, salt: "short" }, "passphrase-1"), /format/);
  await assert.rejects(C.decrypt({ ...pkg, kdf: "MD5" }, "passphrase-1"), /format/);
  await assert.rejects(C.decrypt({ format: "other" }, "passphrase-1"), /format/);
  assert.equal(C.isEncrypted({ decisions: [] }), false);
});
