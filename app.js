"use strict";

/*
 * 判断ログ（画面）
 * - 4段階: ①基準 ②直感をロック → ③AIの提案 → ④決定 → ⑤振り返り
 *   ロックより前にAIの提案は記録できない（AIに引きずられる前に自分の考えを固めるため）。
 * - データは localStorage のみ。外部通信なし（CSPでも禁止）。
 * - 描画は textContent / createElement(NS) のみ。innerHTML は使わない。
 */
(function () {
  const { Stats, Store, JournalCrypto } = window;
  const { LIMITS } = Store;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const STATUS_LABEL = { considering: "検討中", waiting: "結果待ち", reviewed: "振り返り済み" };

  let state = Store.load();
  const openState = new Map(); // 判断ID → ユーザーが開閉した状態
  const $ = (id) => document.getElementById(id);
  const now = () => new Date();
  const today = () => Stats.ymd(now());

  // ---------- 小さな部品 ----------
  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [key, val] of Object.entries(props || {})) {
      if (key === "text") node.textContent = val;
      else if (key === "class") node.className = val;
      else node.setAttribute(key, val);
    }
    (children || []).forEach((c) => node.appendChild(c));
    return node;
  }
  function svg(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, val] of Object.entries(attrs || {})) node.setAttribute(key, String(val));
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function showMsg(text, isError) {
    const box = $("msg");
    box.textContent = text;
    box.className = isError ? "msg err" : "msg";
  }
  function persist() {
    if (!Store.save(state)) showMsg("ブラウザに保存できませんでした。JSONで書き出してバックアップしてください。", true);
  }
  const pct = (x) => `${Math.round(x * 100)}%`;
  const label = (d, i) => (i >= 0 && i < d.options.length ? d.options[i] : "");

  function optionSelect(d, value, blankText, disabled) {
    const select = el("select", { "aria-label": blankText || "選択肢" });
    if (blankText) select.appendChild(el("option", { value: "-1", text: blankText }));
    d.options.forEach((o, i) => select.appendChild(el("option", { value: String(i), text: o })));
    select.value = String(value);
    select.disabled = !!disabled;
    return select;
  }

  // ---------- 全体の描画 ----------
  function render() {
    renderDue();
    renderInsights();
    renderList();
  }

  function renderDue() {
    const box = $("due-banner");
    const due = Stats.dueReviews(state.decisions, now());
    box.replaceChildren();
    box.hidden = due.length === 0;
    if (!due.length) return;
    box.appendChild(el("h2", { text: `振り返りの期限が来ています（${due.length}件）` }));
    const ul = el("ul", { class: "findings" });
    for (const d of due) {
      const open = el("button", { type: "button", class: "ghost small", text: "開く" });
      open.addEventListener("click", () => { openState.set(d.id, true); renderList(); const node = document.getElementById("d-" + d.id); if (node && node.scrollIntoView) node.scrollIntoView(); });
      ul.appendChild(el("li", {}, [el("span", { text: `${d.question}（期限 ${d.review.due}） ` }), open]));
    }
    box.appendChild(ul);
  }

  // ---------- 傾向（洞察） ----------
  function renderInsights() {
    const root = $("insights");
    root.replaceChildren();
    const ds = state.decisions;
    const reviewed = ds.filter(Stats.isReviewed);
    const cal = Stats.calibration(ds);
    const lock = Stats.lockRate(ds);

    const kpi = (name, value) => el("div", {}, [el("dt", { text: name }), el("dd", { text: value })]);
    root.appendChild(el("dl", { class: "kpis" }, [
      kpi("判断の数", `${ds.length}件`),
      kpi("振り返り済み", `${reviewed.length}件`),
      kpi("事前ロック率", lock === null ? "–" : pct(lock)),
      kpi("Brierスコア", cal.brier === null ? "–" : cal.brier.toFixed(2)),
    ]));

    if (reviewed.length === 0) {
      root.appendChild(el("p", { class: "muted", text: "振り返りを記録すると、自信度の合い具合や、基準・直感・AIそれぞれに従った時の成功率がここに出ます。「架空のサンプルを読み込む」で例を見られます。" }));
      return;
    }

    const grid = el("div", { class: "ins-grid" });
    grid.appendChild(calibrationChart(cal));

    const right = el("div");
    right.appendChild(voiceTable());
    const sw = Stats.switchStats(ds);
    if (sw.total > 0) {
      right.appendChild(el("p", { class: "muted", text: `直感とAIが割れた判断: ${sw.total}件（AIに乗り換え ${sw.followedAI.good}/${sw.followedAI.n} 成功、直感を貫いた ${sw.keptGut.good}/${sw.keptGut.n} 成功、どちらでもない ${sw.other.good}/${sw.other.n} 成功）` }));
    }
    const ul = el("ul", { class: "findings" });
    for (const f of Stats.findings(ds)) ul.appendChild(el("li", { text: f }));
    right.appendChild(ul);
    grid.appendChild(right);
    root.appendChild(grid);
    root.appendChild(el("p", { class: "caveat", text: "注意: 結果が分かるのは実際に選んだ選択肢だけです。選ばなかった選択肢がどうなったかは観測できないため、「従った時の成功率」は「その声が正しかった」ことの証明ではありません。件数が少ない間は区間が広く、偶然の範囲に収まることが多いです。" }));
  }

  function calibrationChart(cal) {
    const W = 270, H = 260, L = 52, T = 10, R = 12, B = 34;
    const pw = W - L - R, ph = H - T - B;
    const x = (p) => L + p * pw;
    const y = (r) => T + (1 - r) * ph;
    const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", class: "chart-svg",
      "aria-label": "自信度と実際の成功率の対応。点が対角線より下なら自信過剰、上なら控えめ。" });
    chart.appendChild(svg("rect", { x: L, y: T, width: pw, height: ph, fill: "none", class: "axis" }));
    chart.appendChild(svg("line", { x1: x(0), y1: y(0), x2: x(1), y2: y(1), class: "diag" }));
    for (const t of [0, 0.5, 1]) {
      chart.appendChild(svg("text", { x: x(t), y: H - B + 14 }, pct(t)));
      chart.appendChild(svg("text", { x: L - 6, y: y(t) + 3, class: "ytick" }, pct(t)));
    }
    chart.appendChild(svg("text", { x: L + pw / 2, y: H - 6 }, "自信度"));
    chart.appendChild(svg("text", { x: 11, y: T + ph / 2, transform: `rotate(-90 11 ${T + ph / 2})` }, "実際の成功率"));
    for (const b of cal.buckets) {
      const dot = svg("circle", { cx: x(b.meanP), cy: y(b.rate), r: 4 + Math.min(8, b.n), class: "dot" });
      dot.appendChild(svg("title", {}, `自信度${b.lo}〜${b.hi}%: ${b.n}件、成功率${pct(b.rate)}`));
      chart.appendChild(dot);
    }
    return chart;
  }

  function voiceTable() {
    const table = el("table", { class: "simple" });
    table.appendChild(el("tr", {}, ["", "従った時", "従わなかった時"].map((t) => el("th", { text: t }))));
    const cell = (g) => (g.n === 0 ? "–" : `${g.good}/${g.n}（${pct(g.rate)}、区間 ${pct(g.ci.low)}〜${pct(g.ci.high)}）`);
    for (const [voice, name] of [["matrix", "基準"], ["gut", "直感"], ["ai", "AI"]]) {
      const v = Stats.voiceStats(state.decisions, voice);
      table.appendChild(el("tr", {}, [
        el("th", { text: name }), el("td", { class: "num", text: cell(v.agree) }), el("td", { class: "num", text: cell(v.disagree) }),
      ]));
    }
    return table;
  }

  // ---------- 判断カード ----------
  function renderList() {
    const root = $("list");
    root.replaceChildren();
    if (!state.decisions.length) {
      root.appendChild(el("p", { class: "muted", text: "まだ判断がありません。上のフォームから始めてください。" }));
      return;
    }
    const sorted = [...state.decisions].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    for (const d of sorted) root.appendChild(decisionCard(d));
  }

  function decisionCard(d) {
    const status = Stats.status(d);
    const overdue = status === "waiting" && d.review.due && d.review.due <= today();
    const defaultOpen = status === "considering" || overdue;
    const details = el("details", { class: "card decision", id: "d-" + d.id });
    details.open = openState.has(d.id) ? openState.get(d.id) : defaultOpen;
    details.addEventListener("toggle", () => openState.set(d.id, details.open));

    const badges = el("span", { class: "row" }, [el("span", { class: "badge" + (status === "waiting" ? " waiting" : ""), text: STATUS_LABEL[status] })]);
    if (overdue) badges.appendChild(el("span", { class: "badge due", text: "振り返り期限" }));
    if (status === "reviewed") badges.appendChild(el("span", { class: "badge " + d.review.outcome, text: d.review.outcome === "good" ? "良い結果" : "良くない結果" }));
    details.appendChild(el("summary", {}, [el("h3", { text: d.question }), badges]));

    const body = el("div", { class: "body" });
    if (d.context) body.appendChild(el("p", { class: "muted", text: d.context }));
    body.appendChild(voicesLine(d));
    body.appendChild(stepMatrix(d));
    body.appendChild(stepGut(d));
    body.appendChild(stepAI(d));
    body.appendChild(stepFinal(d));
    if (Stats.isDecided(d)) body.appendChild(stepReview(d));

    const del = el("button", { type: "button", class: "danger small", text: "この判断を削除" });
    del.addEventListener("click", () => {
      if (!confirm(`「${d.question}」を削除しますか？`)) return;
      state.decisions = state.decisions.filter((x) => x.id !== d.id);
      persist(); render();
    });
    body.appendChild(el("div", { class: "actions" }, [del]));
    details.appendChild(body);
    return details;
  }

  function voicesLine(d) {
    const m = Stats.matrixPick(d);
    const items = [
      el("span", { class: "voice", text: `基準: ${m >= 0 ? label(d, m) : d.criteria.length ? "同点" : "未設定"}` }),
      el("span", { class: "voice" + (d.gut.lockedAt ? " locked" : ""), text: `直感: ${d.gut.pick >= 0 ? label(d, d.gut.pick) : "未確定"}${d.gut.lockedAt ? "（ロック済）" : ""}` }),
      el("span", { class: "voice", text: `AI: ${d.ai.pick >= 0 ? label(d, d.ai.pick) : "未記録"}` }),
    ];
    if (Stats.isDecided(d)) items.push(el("span", { class: "voice", text: `決定: ${label(d, d.final.pick)}` }));
    return el("div", { class: "voices" }, items);
  }

  function step(no, title, hint, extraClass) {
    const box = el("div", { class: "step" + (extraClass ? " " + extraClass : "") });
    box.appendChild(el("h4", {}, [el("span", { class: "no", text: String(no) }), document.createTextNode(title)]));
    if (hint) box.appendChild(el("p", { class: "hint", text: hint }));
    return box;
  }

  // ① 基準マトリクス
  function stepMatrix(d) {
    const locked = !!d.gut.lockedAt;
    const box = step(1, "基準で比べる", locked ? "ロック済みのため変更できません。" : "各基準の重みと、選択肢ごとの点数（1〜5）を付けます。", locked ? "locked-step" : "");
    if (!d.criteria.length) {
      box.appendChild(el("p", { class: "muted", text: "基準が設定されていません。基準なしで直感とAIだけで判断します。" }));
      return box;
    }
    const table = el("table", { class: "matrix" });
    table.appendChild(el("tr", {}, [el("th", { text: "基準（重み）" }), ...d.options.map((o) => el("th", { text: o }))]));
    const totalCells = d.options.map(() => el("td", { text: "–" }));
    const updateTotals = () => {
      const scores = Stats.weightedScores(d);
      const win = Stats.matrixPick(d);
      scores.forEach((s, j) => {
        totalCells[j].textContent = s === null ? "–" : s.toFixed(2);
        totalCells[j].className = j === win ? "win" : "";
      });
    };
    d.criteria.forEach((c, i) => {
      const w = el("select", { "aria-label": `${c.name}の重み` });
      for (let v = 1; v <= 5; v++) w.appendChild(el("option", { value: String(v), text: String(v) }));
      w.value = String(c.weight);
      w.disabled = locked;
      w.addEventListener("change", () => { c.weight = Store.clampInt(w.value, 1, 5, 3); persist(); updateTotals(); });
      const row = el("tr", {}, [el("td", {}, [document.createTextNode(c.name + " "), w])]);
      d.options.forEach((o, j) => {
        const s = el("select", { "aria-label": `${c.name}: ${o}の点数` });
        for (let v = 1; v <= 5; v++) s.appendChild(el("option", { value: String(v), text: String(v) }));
        s.value = String(d.scores[i][j]);
        s.disabled = locked;
        s.addEventListener("change", () => { d.scores[i][j] = Store.clampInt(s.value, 1, 5, 3); persist(); updateTotals(); });
        row.appendChild(el("td", {}, [s]));
      });
      table.appendChild(row);
    });
    table.appendChild(el("tr", { class: "total" }, [el("td", { text: "加重平均" }), ...totalCells]));
    updateTotals();
    box.appendChild(table);
    return box;
  }

  // ② 直感をロック
  function stepGut(d) {
    const locked = !!d.gut.lockedAt;
    const box = step(2, "直感を確定してロックする",
      locked ? `${d.gut.lockedAt} にロックしました。この予想はもう変更できません。` : "AIに聞く前に、自分ならどれを選ぶかを決めてロックします。ロックすると基準と直感は変更できなくなり、AIの提案を記録できるようになります。",
      locked ? "locked-step" : "");
    const select = optionSelect(d, d.gut.pick, "まだ決めていない", locked);
    const btn = el("button", { type: "button", class: "lock", text: "ロックする" });
    btn.disabled = locked || d.gut.pick < 0;
    select.addEventListener("change", () => { d.gut.pick = Store.clampInt(select.value, -1, d.options.length - 1, -1); btn.disabled = d.gut.pick < 0; persist(); });
    btn.addEventListener("click", () => {
      if (d.gut.pick < 0) return;
      d.gut.lockedAt = today();
      persist(); render();
    });
    box.appendChild(el("div", { class: "field-row" }, [el("label", {}, [el("span", { text: "自分ならこれを選ぶ" }), select]), ...(locked ? [] : [btn])]));
    return box;
  }

  // ③ AIの提案
  function stepAI(d) {
    const unlocked = !!d.gut.lockedAt;
    const decided = Stats.isDecided(d);
    const enabled = unlocked && !decided;
    const box = step(3, "AI・他者の提案を記録する",
      unlocked ? "提案をそのまま記録します（採用するかは次の手順で決めます）。" : "手順2でロックすると使えます。先に自分の考えを固めることで、提案に引きずられにくくなります。",
      unlocked ? "" : "off");
    const source = el("input", { type: "text", maxlength: String(LIMITS.source), placeholder: "例: ChatGPT / 先輩 / 記事", "aria-label": "提案元", value: d.ai.source });
    source.disabled = !enabled;
    const pick = optionSelect(d, d.ai.pick, "提案なし", !enabled);
    const note = el("textarea", { rows: "2", maxlength: String(LIMITS.note), placeholder: "提案の理由・メモ", "aria-label": "提案のメモ" });
    note.value = d.ai.note;
    note.disabled = !enabled;
    const save = el("button", { type: "button", class: "ghost small", text: "提案を記録" });
    save.disabled = !enabled;
    save.addEventListener("click", () => {
      d.ai.source = Store.cleanText(source.value, LIMITS.source);
      d.ai.pick = Store.clampInt(pick.value, -1, d.options.length - 1, -1);
      d.ai.note = Store.cleanText(note.value, LIMITS.note, true);
      d.ai.recordedAt = d.ai.pick >= 0 || d.ai.source ? today() : "";
      persist(); render(); showMsg("提案を記録しました。");
    });
    box.appendChild(el("div", { class: "field-row" }, [el("label", {}, [el("span", { text: "提案元" }), source]), el("label", {}, [el("span", { text: "提案された選択肢" }), pick])]));
    box.appendChild(note);
    box.appendChild(el("div", { class: "actions" }, [save]));
    return box;
  }

  // ④ 決定
  function stepFinal(d) {
    if (Stats.isDecided(d)) {
      const box = step(4, "決定", "", "locked-step");
      box.appendChild(el("p", { text: `${d.final.date}: 「${label(d, d.final.pick)}」を選びました。良い結果になる確率の見立て: ${d.final.confidence}%` }));
      if (d.final.reason) box.appendChild(el("p", { class: "muted", text: `理由: ${d.final.reason}` }));
      const note = [];
      if (d.gut.pick >= 0 && d.ai.pick >= 0 && d.gut.pick !== d.ai.pick) {
        note.push(d.final.pick === d.ai.pick ? "直感とAIが割れて、AIの提案を採用しました。" : d.final.pick === d.gut.pick ? "直感とAIが割れて、直感を貫きました。" : "直感ともAIとも違う選択肢を選びました。");
      }
      if (note.length) box.appendChild(el("p", { class: "muted", text: note[0] }));
      return box;
    }
    const box = step(4, "決定する", "選ぶ選択肢と、「良い結果になる確率」を%で書きます。決定すると変更できません（結果と見比べるため）。");
    const pick = optionSelect(d, -1, "選択してください", false);
    const conf = el("input", { type: "number", min: "1", max: "99", value: "60", "aria-label": "良い結果になる確率（%）" });
    const reason = el("textarea", { rows: "2", maxlength: String(LIMITS.note), placeholder: "選んだ理由", "aria-label": "理由" });
    const dueDate = el("input", { type: "date", "aria-label": "振り返り日", value: Stats.ymd(Stats.addDays(now(), 14)) });
    const btn = el("button", { type: "button", text: "決定する" });
    btn.addEventListener("click", () => {
      const p = Store.clampInt(pick.value, -1, d.options.length - 1, -1);
      const c = Store.clampInt(conf.value, 1, 99, 0);
      if (p < 0) { showMsg("選択肢を選んでください。", true); return; }
      if (!c) { showMsg("確率は1〜99で入力してください。", true); return; }
      d.final = { pick: p, date: today(), confidence: c, reason: Store.cleanText(reason.value, LIMITS.note, true) };
      d.review.due = Store.cleanDate(dueDate.value) || Stats.ymd(Stats.addDays(now(), 14));
      persist(); render(); showMsg("決定を記録しました。振り返り日に結果を書き込みましょう。");
    });
    box.appendChild(el("div", { class: "field-row" }, [
      el("label", {}, [el("span", { text: "選ぶ" }), pick]),
      el("label", {}, [el("span", { text: "良い結果になる確率（%）" }), conf]),
      el("label", {}, [el("span", { text: "振り返り日" }), dueDate]),
    ]));
    box.appendChild(reason);
    box.appendChild(el("div", { class: "actions" }, [btn]));
    return box;
  }

  // ⑤ 振り返り
  function stepReview(d) {
    if (Stats.isReviewed(d)) {
      const box = step(5, "振り返り", "", "locked-step");
      box.appendChild(el("p", { text: `${d.review.date || ""} 結果: ${d.review.outcome === "good" ? "良い結果" : "良くない結果"}` }));
      if (d.review.lesson) box.appendChild(el("p", { class: "muted", text: `学び: ${d.review.lesson}` }));
      return box;
    }
    const box = step(5, "振り返る", `振り返り日: ${d.review.due || "未設定"}。結果が分かったら記録します。`);
    const outcome = el("select", { "aria-label": "結果" }, [
      el("option", { value: "", text: "選んでください" }),
      el("option", { value: "good", text: "良い結果だった" }),
      el("option", { value: "bad", text: "良くない結果だった" }),
    ]);
    const lesson = el("textarea", { rows: "2", maxlength: String(LIMITS.note), placeholder: "学び・次に活かすこと", "aria-label": "学び" });
    const btn = el("button", { type: "button", text: "結果を記録" });
    btn.addEventListener("click", () => {
      if (outcome.value !== "good" && outcome.value !== "bad") { showMsg("結果を選んでください。", true); return; }
      d.review.outcome = outcome.value;
      d.review.lesson = Store.cleanText(lesson.value, LIMITS.note, true);
      d.review.date = today();
      persist(); render(); showMsg("結果を記録しました。傾向に反映されます。");
    });
    box.appendChild(el("div", { class: "field-row" }, [el("label", {}, [el("span", { text: "結果" }), outcome])]));
    box.appendChild(lesson);
    box.appendChild(el("div", { class: "actions" }, [btn]));
    return box;
  }

  // ---------- 新規作成 ----------
  $("new-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.decisions.length >= LIMITS.decisions) { showMsg(`判断は${LIMITS.decisions}件までです。`, true); return; }
    const d = Store.createDecision($("new-question").value, $("new-context").value, $("new-options").value, $("new-criteria").value, today());
    if (!d) { showMsg("決めたいことと、2つ以上の選択肢（1行に1つ）を入力してください。", true); return; }
    state.decisions.push(d);
    openState.set(d.id, true);
    for (const id of ["new-question", "new-context", "new-options", "new-criteria"]) $(id).value = "";
    persist(); render(); showMsg("判断を作りました。まず基準を付け、直感をロックしましょう。");
  });

  // ---------- サンプル ----------
  function sampleData() {
    const day = (n) => Stats.ymd(Stats.addDays(now(), n));
    const crit = [{ name: "ユーザーへの効果", weight: 5 }, { name: "実装コスト", weight: 3 }, { name: "リスク", weight: 2 }];
    const scoresFor = (k, n) => crit.map((_, i) => Array.from({ length: n }, (__, j) => ((i * 3 + j * 2 + k * 5) % 5) + 1));
    // [質問, 選択肢, 直感, AI, 決定, 自信度, 結果, 何日前]
    const rows = [
      ["次に作る機能を決める", ["検索の改善", "通知の刷新", "決済の簡略化"], 0, 1, 1, 70, "good", 60],
      ["学習する言語を決める", ["TypeScript", "Go", "Python"], 2, 2, 2, 80, "good", 55],
      ["リリース時期を決める", ["今月末", "来月", "再来月"], 0, 1, 0, 85, "bad", 50],
      ["ツールを導入するか", ["導入する", "見送る"], 0, 0, 0, 75, "good", 46],
      ["ミーティングの形式", ["毎日15分", "週2回", "非同期のみ"], 1, 2, 2, 65, "good", 42],
      ["価格プランの方針", ["無料中心", "月額制", "従量課金"], 1, 0, 0, 80, "bad", 38],
      ["記事のテーマ選び", ["AIの使い方", "学習法", "時間管理"], 0, 0, 0, 90, "bad", 34],
      ["デザインの方向性", ["シンプル", "情報量多め"], 0, 1, 1, 60, "good", 30],
      ["優先する不具合", ["表示崩れ", "検索遅延", "通知漏れ"], 1, 1, 1, 70, "good", 26],
      ["チーム分担", ["担当制", "ローテーション"], 0, 1, 0, 85, "bad", 22],
      ["勉強会の頻度", ["週1", "隔週", "月1"], 1, 1, 1, 70, "good", 18],
      ["データの保存方式", ["ローカル", "クラウド"], 0, 0, 0, 95, "good", 15],
    ];
    const decisions = rows.map(([question, options, gut, ai, fin, conf, outcome, age], k) => ({
      id: `sample-${k}`, createdAt: day(-age), question, options, criteria: crit, scores: scoresFor(k, options.length),
      gut: { pick: gut, lockedAt: day(-age) },
      ai: { source: "AIアシスタント（架空）", pick: ai, note: "", recordedAt: day(-age) },
      final: { pick: fin, date: day(-age + 1), confidence: conf, reason: "" },
      review: { due: day(-age + 14), outcome, lesson: "", date: day(Math.min(0, -age + 15)) },
    }));
    const opts3 = ["案A", "案B", "案C"];
    decisions.push(
      { id: "sample-w1", createdAt: day(-20), question: "来月の目標を決める", options: opts3, criteria: crit, scores: scoresFor(20, 3),
        gut: { pick: 0, lockedAt: day(-20) }, ai: { source: "AIアシスタント（架空）", pick: 1, note: "", recordedAt: day(-20) },
        final: { pick: 1, date: day(-19), confidence: 65, reason: "AIの理由に納得したため" }, review: { due: day(-6), outcome: "", lesson: "", date: "" } },
      { id: "sample-w2", createdAt: day(-3), question: "次の学習計画を決める", options: opts3, criteria: crit, scores: scoresFor(21, 3),
        gut: { pick: 2, lockedAt: day(-3) }, ai: { source: "", pick: -1, note: "", recordedAt: "" },
        final: { pick: 2, date: day(-2), confidence: 70, reason: "" }, review: { due: day(10), outcome: "", lesson: "", date: "" } },
      { id: "sample-c1", createdAt: day(-1), question: "新しい習慣を始めるか", options: ["始める", "見送る"], criteria: crit, scores: scoresFor(22, 2),
        gut: { pick: -1, lockedAt: "" }, ai: { source: "", pick: -1, note: "", recordedAt: "" },
        final: { pick: -1, date: "", confidence: 0, reason: "" }, review: { due: "", outcome: "", lesson: "", date: "" } },
      { id: "sample-c2", createdAt: day(0), question: "価格の見直しをするか", options: ["見直す", "据え置く"], criteria: crit, scores: scoresFor(23, 2),
        gut: { pick: 1, lockedAt: day(0) }, ai: { source: "", pick: -1, note: "", recordedAt: "" },
        final: { pick: -1, date: "", confidence: 0, reason: "" }, review: { due: "", outcome: "", lesson: "", date: "" } }
    );
    return Store.sanitize({ decisions });
  }

  $("btn-sample").addEventListener("click", () => {
    if (state.decisions.length && !confirm("現在のデータはサンプルで置き換わります。よろしいですか？")) return;
    state = sampleData();
    persist(); render(); showMsg("架空のサンプルを読み込みました。");
  });

  // ---------- 書き出し・読み込み ----------
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  $("btn-export").addEventListener("click", () => {
    download("decision-journal.json", JSON.stringify(state, null, 2));
    showMsg("JSONを書き出しました（暗号化されていません。保管に注意してください）。");
  });

  $("btn-export-enc").addEventListener("click", async () => {
    try {
      const pkg = await JournalCrypto.encrypt(state, $("passphrase").value);
      download("decision-journal.encrypted.json", JSON.stringify(pkg));
      showMsg("暗号化して書き出しました。パスフレーズは保存されていません。");
    } catch (err) {
      showMsg(err && err.message === "weak-passphrase" ? `パスフレーズは${JournalCrypto.MIN_PASS}文字以上にしてください。` : "暗号化できませんでした。このブラウザは対応していない可能性があります。", true);
    }
  });

  $("file-import").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > LIMITS.fileBytes) { showMsg("ファイルが大きすぎます（2MBまで）。", true); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        let data = JSON.parse(String(reader.result));
        if (JournalCrypto.isEncrypted(data)) {
          if (!$("passphrase").value) { showMsg("暗号化されたファイルです。パスフレーズを入力してから、もう一度選んでください。", true); return; }
          data = await JournalCrypto.decrypt(data, $("passphrase").value);
        }
        const parsed = Store.sanitize(data);
        if (!parsed) throw new Error("format");
        if (state.decisions.length && !confirm("現在のデータは読み込んだ内容で置き換わります。よろしいですか？")) return;
        state = parsed;
        persist(); render(); showMsg("読み込みました。");
      } catch (_) {
        showMsg("読み込めませんでした。ファイルの形式か、パスフレーズを確認してください。", true);
      }
    };
    reader.readAsText(file);
  });

  $("btn-reset").addEventListener("click", () => {
    if (!confirm("このブラウザに保存された全データを削除します。よろしいですか？")) return;
    state = Store.emptyState();
    Store.clear();
    render(); showMsg("削除しました。");
  });

  render();
})();
