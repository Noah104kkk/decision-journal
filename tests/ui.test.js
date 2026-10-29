"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

function boot() {
  const html = read("index.html").replace(/<script src="[^"]+"><\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  const w = dom.window;
  w.confirm = () => true;
  for (const f of ["stats.js", "store.js", "crypto.js", "app.js"]) w.eval(read(f));
  return w;
}

const fire = (w, node, type) => node.dispatchEvent(new w.Event(type, { cancelable: true, bubbles: true }));
const byText = (root, selector, text) => [...root.querySelectorAll(selector)].find((n) => n.textContent.includes(text));

function create(w, question, options, criteria) {
  const d = w.document;
  d.getElementById("new-question").value = question;
  d.getElementById("new-options").value = options;
  d.getElementById("new-criteria").value = criteria || "";
  fire(w, d.getElementById("new-form"), "submit");
}

test("HTMLを含む入力は文字として表示され、要素として実行されない", () => {
  const w = boot();
  create(w, "<img src=x onerror=alert(1)>", "<b>A</b>\nB", "<i>基準</i> 5");
  const d = w.document;
  assert.equal(d.querySelector("#list img, #list b, #list i"), null);
  assert.ok(d.querySelector("#list h3").textContent.includes("<img"));
});

test("選択肢が2つ未満なら作れない", () => {
  const w = boot();
  create(w, "質問", "Aだけ");
  assert.equal(w.document.querySelectorAll("#list .decision").length, 0);
  assert.equal(w.document.getElementById("msg").className, "msg err");
});

test("ロックの順序: 直感をロックするまでAIの提案欄は無効、ロック後は直感を変更できない", () => {
  const w = boot();
  create(w, "どれにする？", "A\nB\nC", "効果 5\nコスト 2");
  const d = w.document;
  const card = d.querySelector("#list .decision");
  const aiStep = [...card.querySelectorAll(".step")].find((s) => s.textContent.includes("AI・他者"));
  assert.ok(aiStep.classList.contains("off"));
  assert.ok([...aiStep.querySelectorAll("input,select,textarea,button")].every((n) => n.disabled));

  const gutStep = [...card.querySelectorAll(".step")].find((s) => s.textContent.includes("直感を確定"));
  const lockBtn = gutStep.querySelector("button.lock");
  assert.equal(lockBtn.disabled, true, "直感を選ぶまでロックできない");
  const sel = gutStep.querySelector("select");
  sel.value = "1"; fire(w, sel, "change");
  assert.equal(gutStep.querySelector("button.lock").disabled, false);
  gutStep.querySelector("button.lock").click();

  const card2 = d.querySelector("#list .decision");
  const gut2 = [...card2.querySelectorAll(".step")].find((s) => s.textContent.includes("直感を確定"));
  assert.ok(gut2.querySelector("select").disabled, "ロック後は変更不可");
  const ai2 = [...card2.querySelectorAll(".step")].find((s) => s.textContent.includes("AI・他者"));
  assert.ok(!ai2.classList.contains("off"));
  assert.ok(ai2.querySelector("input").disabled === false);
  assert.ok(card2.querySelector(".voice.locked"));
  assert.ok([...card2.querySelectorAll("table.matrix select")].every((s) => s.disabled), "基準もロックされる");
});

test("通し: 作成→ロック→AI提案→決定→振り返り→傾向に反映", () => {
  const w = boot();
  create(w, "通しテスト", "A\nB", "効果 5");
  const d = w.document;
  const stepOf = (text) => [...d.querySelector("#list .decision").querySelectorAll(".step")].find((s) => s.textContent.includes(text));

  let s = stepOf("直感を確定");
  s.querySelector("select").value = "0"; fire(w, s.querySelector("select"), "change");
  s.querySelector("button.lock").click();

  s = stepOf("AI・他者");
  s.querySelector("input").value = "テストAI";
  s.querySelector("select").value = "1";
  byText(s, "button", "提案を記録").click();

  s = stepOf("決定する");
  s.querySelector("select").value = "1";
  s.querySelector("input[type=number]").value = "80";
  byText(s, "button", "決定する").click();
  assert.ok(stepOf("決定").textContent.includes("80%"));
  assert.ok(d.querySelector(".voices").textContent.includes("決定: B"));

  s = stepOf("振り返る");
  s.querySelector("select").value = "good";
  byText(s, "button", "結果を記録").click();

  assert.ok(d.querySelector(".badge.good"));
  assert.match(d.getElementById("insights").textContent, /振り返り済み1件/);
  assert.ok(w.localStorage.getItem("decision-journal:v1"));
});

test("決定時に選択肢を選ばないと記録されない", () => {
  const w = boot();
  create(w, "未選択", "A\nB");
  const d = w.document;
  const s = [...d.querySelector("#list .decision").querySelectorAll(".step")].find((x) => x.textContent.includes("決定する"));
  byText(s, "button", "決定する").click();
  assert.equal(d.getElementById("msg").className, "msg err");
  assert.match(d.querySelector("#list .badge").textContent, /検討中/);
});

test("サンプル: 傾向（較正グラフ・声ごとの表・所見）と、振り返り期限のバナーが出る", () => {
  const w = boot();
  w.document.getElementById("btn-sample").click();
  const d = w.document;
  assert.ok(d.querySelector("#insights svg circle.dot"));
  assert.equal(d.querySelectorAll("#insights table.simple tr").length, 4);
  assert.ok(d.querySelectorAll("#insights ul.findings li").length > 0);
  assert.equal(d.getElementById("due-banner").hidden, false);
  assert.match(d.getElementById("due-banner").textContent, /来月の目標を決める/);
  assert.ok(d.querySelectorAll("#list .decision").length >= 14);
});

test("全データ削除で空に戻り、保存データも消える", () => {
  const w = boot();
  create(w, "消す", "A\nB");
  w.document.getElementById("btn-reset").click();
  assert.equal(w.document.querySelectorAll("#list .decision").length, 0);
  assert.equal(w.localStorage.getItem("decision-journal:v1"), null);
});

test("パスフレーズが短いと暗号化書き出しを拒否し、ファイルを作らない", async () => {
  const w = boot();
  let downloaded = false;
  w.URL.createObjectURL = () => { downloaded = true; return "blob:x"; };
  w.document.getElementById("passphrase").value = "short";
  w.document.getElementById("btn-export-enc").click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(downloaded, false);
  assert.equal(w.document.getElementById("msg").className, "msg err");
});

test("セキュリティ: CSPが外部接続を禁止し、危険なAPIを使っていない", () => {
  const html = read("index.html");
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "インラインスクリプトなし");
  assert.doesNotMatch(html, /https?:\/\//, "外部URLの読み込みなし");
  for (const f of ["app.js", "store.js", "stats.js", "crypto.js"]) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\.innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|Math\.random\(\).*(salt|iv|key)/, f);
  }
});
