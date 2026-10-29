"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Store = require("../store.js");

const base = () => ({
  question: "どれにする？",
  options: ["A", "B"],
  criteria: [{ name: "効果", weight: 5 }],
  scores: [[4, 2]],
});

test("sanitize: 形式が違う入力は null、空配列は空の状態", () => {
  for (const bad of [null, undefined, 1, "x", [], {}, { decisions: "x" }]) assert.equal(Store.sanitize(bad), null);
  assert.deepEqual(Store.sanitize({ decisions: [] }).decisions, []);
});

test("sanitize: 質問が空・選択肢が2未満の判断は捨てる。選択肢の重複は除く", () => {
  const data = Store.sanitize({ decisions: [
    { ...base(), question: "  " },
    { ...base(), options: ["A"] },
    { ...base(), options: ["A", "A", "B"] },
  ] });
  assert.equal(data.decisions.length, 1);
  assert.deepEqual(data.decisions[0].options, ["A", "B"]);
});

test("sanitize: 制御文字の除去と長さ制限", () => {
  const d = Store.sanitize({ decisions: [{ ...base(), question: "a\u0000b".repeat(100), context: "x".repeat(900) }] }).decisions[0];
  assert.ok(!/\u0000/.test(d.question));
  assert.equal(d.question.length, Store.LIMITS.question);
  assert.equal(d.context.length, Store.LIMITS.context);
});

test("sanitize: 範囲外の点数・重み・選択肢番号は安全な値に直す", () => {
  const d = Store.sanitize({ decisions: [{
    ...base(), criteria: [{ name: "x", weight: 99 }], scores: [[0, 99]],
    gut: { pick: 7, lockedAt: "2026-02-31" }, final: { pick: 1, date: "2026-10-01", confidence: 500 },
  }] }).decisions[0];
  assert.equal(d.criteria[0].weight, 3);
  assert.deepEqual(d.scores[0], [3, 3]);
  assert.equal(d.gut.pick, -1);
  assert.equal(d.gut.lockedAt, "");
  assert.equal(d.final.confidence, 60);
});

test("sanitize: 決定していない判断に結果・期限・確信は残さない", () => {
  const d = Store.sanitize({ decisions: [{ ...base(), final: { pick: -1, confidence: 80 }, review: { due: "2026-10-10", outcome: "good", lesson: "x" } }] }).decisions[0];
  assert.equal(d.final.confidence, 0);
  assert.equal(d.review.outcome, "");
  assert.equal(d.review.due, "");
});

test("sanitize: 結果は good / bad 以外を受け付けない（__proto__ 等も）", () => {
  const mk = (outcome) => Store.sanitize({ decisions: [{ ...base(), final: { pick: 0, date: "2026-10-01", confidence: 60 }, review: { outcome } }] }).decisions[0].review.outcome;
  assert.equal(mk("good"), "good");
  for (const bad of ["__proto__", "constructor", "GOOD", 1, null]) assert.equal(mk(bad), "");
});

test("sanitize: IDの重複・不正IDは振り直す。件数上限を守る", () => {
  const ds = Store.sanitize({ decisions: [
    { ...base(), id: "same" }, { ...base(), id: "same" }, { ...base(), id: "<script>" },
  ] }).decisions;
  assert.equal(new Set(ds.map((d) => d.id)).size, 3);
  assert.ok(ds.every((d) => /^[A-Za-z0-9-]{1,64}$/.test(d.id)));
  const many = Array.from({ length: 600 }, () => base());
  assert.equal(Store.sanitize({ decisions: many }).decisions.length, Store.LIMITS.decisions);
});

test("createDecision: 1行1項目のテキストから作り、基準は「名前 重み」を読む", () => {
  const d = Store.createDecision("Q", "", "A\nB\n\nC", "効果 5\nコスト\n  使いやすさ 2 ", "2026-10-29");
  assert.deepEqual(d.options, ["A", "B", "C"]);
  assert.deepEqual(d.criteria, [
    { name: "効果", weight: 5 }, { name: "コスト", weight: 3 }, { name: "使いやすさ", weight: 2 },
  ]);
  assert.equal(d.scores.length, 3);
  assert.equal(Store.createDecision("Q", "", "A", "", "2026-10-29"), null);
});
