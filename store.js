"use strict";

/*
 * 保存と検証。localStorage・JSON・復号結果は、必ず sanitize を通してから使う。
 * 形式が壊れていても例外を出さず、安全な形に直す（直せなければ捨てる）。
 */
(function (root) {
  const STORAGE_KEY = "decision-journal:v1";
  const LIMITS = {
    decisions: 500, options: 5, criteria: 6,
    question: 120, context: 500, label: 60, criterion: 40, source: 40, note: 300, fileBytes: 2 * 1024 * 1024,
  };

  function newId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  const cleanId = (v) => (typeof v === "string" && /^[A-Za-z0-9-]{1,64}$/.test(v) ? v : newId());

  function cleanText(value, max, keepNewlines) {
    if (typeof value !== "string") return "";
    const pattern = keepNewlines ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
    return value.replace(pattern, "").trim().slice(0, max);
  }

  function cleanDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
    const d = new Date(value + "T00:00:00");
    if (Number.isNaN(d.getTime())) return "";
    const back = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return back === value ? value : "";
  }

  const clampInt = (v, lo, hi, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
  };

  const emptyState = () => ({ version: 1, decisions: [] });

  function cleanDecision(raw, seen) {
    if (!raw || typeof raw !== "object") return null;
    const question = cleanText(raw.question, LIMITS.question);
    if (!question) return null;

    const options = [];
    for (const o of Array.isArray(raw.options) ? raw.options.slice(0, LIMITS.options) : []) {
      const label = cleanText(o, LIMITS.label);
      if (label && !options.includes(label)) options.push(label);
    }
    if (options.length < 2) return null;

    const criteria = [];
    for (const c of Array.isArray(raw.criteria) ? raw.criteria.slice(0, LIMITS.criteria) : []) {
      const name = cleanText(c && c.name, LIMITS.criterion);
      if (name) criteria.push({ name, weight: clampInt(c.weight, 1, 5, 3) });
    }
    const scores = criteria.map((_, i) =>
      options.map((__, j) => clampInt(raw.scores && raw.scores[i] && raw.scores[i][j], 1, 5, 3)));

    const pickIn = (v) => clampInt(v, -1, options.length - 1, -1);
    const g = raw.gut || {};
    const a = raw.ai || {};
    const f = raw.final || {};
    const r = raw.review || {};

    const gutPick = pickIn(g.pick);
    const gut = { pick: gutPick, lockedAt: gutPick >= 0 ? cleanDate(g.lockedAt) : "" };
    const ai = {
      source: cleanText(a.source, LIMITS.source),
      pick: pickIn(a.pick),
      note: cleanText(a.note, LIMITS.note, true),
      recordedAt: cleanDate(a.recordedAt),
    };
    const finalPick = pickIn(f.pick);
    const final = {
      pick: finalPick,
      date: finalPick >= 0 ? cleanDate(f.date) : "",
      confidence: finalPick >= 0 ? clampInt(f.confidence, 1, 99, 60) : 0,
      reason: cleanText(f.reason, LIMITS.note, true),
    };
    const outcome = finalPick >= 0 && (r.outcome === "good" || r.outcome === "bad") ? r.outcome : "";
    const review = {
      due: finalPick >= 0 ? cleanDate(r.due) : "",
      outcome,
      lesson: outcome ? cleanText(r.lesson, LIMITS.note, true) : "",
      date: outcome ? cleanDate(r.date) : "",
    };

    let id = cleanId(raw.id);
    if (seen.has(id)) id = newId();
    seen.add(id);
    return {
      id, createdAt: cleanDate(raw.createdAt), question,
      context: cleanText(raw.context, LIMITS.context, true),
      options, criteria, scores, gut, ai, final, review,
    };
  }

  function sanitize(input) {
    if (!input || typeof input !== "object" || !Array.isArray(input.decisions)) return null;
    const seen = new Set();
    const decisions = [];
    for (const raw of input.decisions.slice(0, LIMITS.decisions)) {
      const d = cleanDecision(raw, seen);
      if (d) decisions.push(d);
    }
    return { version: 1, decisions };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? sanitize(JSON.parse(raw)) || emptyState() : emptyState();
    } catch (_) {
      return emptyState();
    }
  }
  function save(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; } catch (_) { return false; }
  }
  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* 無視 */ }
  }

  /** 新しい判断（検討中）を作る。選択肢・基準は1行1項目のテキストから。基準は「名前 重み」形式。 */
  function createDecision(question, context, optionsText, criteriaText, today) {
    const options = String(optionsText).split(/\r?\n/);
    const criteria = String(criteriaText).split(/\r?\n/).map((line) => {
      const m = line.trim().match(/^(.*?)(?:\s+([1-5]))?$/);
      return { name: m ? m[1] : line, weight: m && m[2] ? Number(m[2]) : 3 };
    });
    return cleanDecision({ question, context, options, criteria, createdAt: today }, new Set());
  }

  const api = { LIMITS, newId, cleanText, cleanDate, clampInt, sanitize, load, save, clear, emptyState, createDecision };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Store = api;
})(typeof window !== "undefined" ? window : globalThis);
