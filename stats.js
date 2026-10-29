"use strict";

/*
 * 判断の分析ロジック（画面・保存に依存しない純粋関数）。
 *
 * 考え方:
 *  - 「声」は3つ: 基準（加重スコア）/ 直感（事前にロックした予想）/ AI（提案）
 *  - 結果が観測できるのは「実際に選んだ選択肢」だけ。選ばなかった選択肢の結果（反事実）は分からない。
 *    そのため「その声に従った時の成功率」を測るだけで、「その声が正しかった」とは言わない。
 *  - 件数が少ないうちは区間（ウィルソン区間）つきで示し、断定しない。
 */
(function (root) {
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() + n); return x; };

  const isDecided = (d) => d.final.pick >= 0;
  const isReviewed = (d) => isDecided(d) && (d.review.outcome === "good" || d.review.outcome === "bad");
  const outcomeOf = (d) => (d.review.outcome === "good" ? 1 : 0);

  function status(d) {
    if (!isDecided(d)) return "considering";
    return isReviewed(d) ? "reviewed" : "waiting";
  }

  /** 基準ごとの重み×点数から、選択肢ごとの加重平均点（1〜5）を出す。基準がなければ null の配列。 */
  function weightedScores(d) {
    const totalW = d.criteria.reduce((s, c) => s + c.weight, 0);
    if (!totalW) return d.options.map(() => null);
    return d.options.map((_, j) => {
      let sum = 0;
      d.criteria.forEach((c, i) => { sum += c.weight * ((d.scores[i] && d.scores[i][j]) || 3); });
      return sum / totalW;
    });
  }

  /** 基準が最高点の選択肢。同点・基準なしは -1（結論を出さない）。 */
  function matrixPick(d) {
    const scores = weightedScores(d);
    if (!scores.length || scores[0] === null) return -1;
    const max = Math.max(...scores);
    const top = scores.map((s, i) => (Math.abs(s - max) < 1e-9 ? i : -1)).filter((i) => i >= 0);
    return top.length === 1 ? top[0] : -1;
  }

  function pickOf(d, voice) {
    if (voice === "gut") return d.gut.pick;
    if (voice === "ai") return d.ai.pick;
    return matrixPick(d);
  }

  /** 比率のウィルソン信頼区間（95%）。少ない件数でも極端な値にならない。 */
  function wilson(k, n) {
    if (n === 0) return { low: 0, high: 1 };
    const z = 1.96;
    const p = k / n;
    const denom = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return { low: Math.max(0, (centre - margin) / denom), high: Math.min(1, (centre + margin) / denom) };
  }

  function group(list) {
    const n = list.length;
    const good = list.filter((d) => outcomeOf(d) === 1).length;
    return { n, good, rate: n ? good / n : null, ci: wilson(good, n) };
  }

  /** その声の提案と実際の決定が「一致した時」「違った時」の成功率。 */
  function voiceStats(decisions, voice) {
    const rs = decisions.filter((d) => isReviewed(d) && pickOf(d, voice) >= 0);
    return {
      agree: group(rs.filter((d) => d.final.pick === pickOf(d, voice))),
      disagree: group(rs.filter((d) => d.final.pick !== pickOf(d, voice))),
    };
  }

  /** 直感とAIが割れた判断で、「AIに乗り換えた／直感を貫いた／どちらでもない」の成否。 */
  function switchStats(decisions) {
    const split = decisions.filter((d) => isReviewed(d) && d.gut.pick >= 0 && d.ai.pick >= 0 && d.gut.pick !== d.ai.pick);
    return {
      followedAI: group(split.filter((d) => d.final.pick === d.ai.pick)),
      keptGut: group(split.filter((d) => d.final.pick === d.gut.pick)),
      other: group(split.filter((d) => d.final.pick !== d.ai.pick && d.final.pick !== d.gut.pick)),
      total: split.length,
    };
  }

  /** 自信度（%）と実際の成功率のずれ。Brierスコアは小さいほど良い（0〜1）。 */
  function calibration(decisions) {
    const rs = decisions.filter((d) => isReviewed(d) && d.final.confidence >= 1 && d.final.confidence <= 99);
    const n = rs.length;
    if (!n) return { n: 0, buckets: [], brier: null, brierBase: null, meanP: null, rate: null, bias: null };
    const edges = [0, 50, 60, 70, 80, 90, 101];
    const buckets = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const inB = rs.filter((d) => d.final.confidence >= edges[i] && d.final.confidence < edges[i + 1]);
      if (!inB.length) continue;
      buckets.push({
        lo: edges[i],
        hi: Math.min(100, edges[i + 1] - 1),
        n: inB.length,
        meanP: inB.reduce((s, d) => s + d.final.confidence / 100, 0) / inB.length,
        rate: inB.reduce((s, d) => s + outcomeOf(d), 0) / inB.length,
      });
    }
    const rate = rs.reduce((s, d) => s + outcomeOf(d), 0) / n;
    const meanP = rs.reduce((s, d) => s + d.final.confidence / 100, 0) / n;
    const brier = rs.reduce((s, d) => s + (d.final.confidence / 100 - outcomeOf(d)) ** 2, 0) / n;
    const brierBase = rs.reduce((s, d) => s + (rate - outcomeOf(d)) ** 2, 0) / n;
    return { n, buckets, brier, brierBase, meanP, rate, bias: meanP - rate };
  }

  /** 振り返り期限が来ている（今日以前）のに、まだ結果を書いていない判断。 */
  function dueReviews(decisions, today) {
    const t = ymd(today);
    return decisions
      .filter((d) => isDecided(d) && !isReviewed(d) && d.review.due && d.review.due <= t)
      .sort((a, b) => a.review.due.localeCompare(b.review.due));
  }

  function lockRate(decisions) {
    const decided = decisions.filter(isDecided);
    if (!decided.length) return null;
    return decided.filter((d) => d.gut.lockedAt).length / decided.length;
  }

  const pct = (x) => `${Math.round(x * 100)}%`;
  const overlap = (a, b) => a.ci.low <= b.ci.high && b.ci.low <= a.ci.high;

  /** 結果を言葉にする。件数が少ない・区間が重なる場合は「断定しない」表現にする。 */
  function findings(decisions) {
    const out = [];
    const reviewed = decisions.filter(isReviewed);
    if (reviewed.length < 5) {
      out.push(`振り返り済みが${reviewed.length}件です。5件未満のうちは、傾向はまだ参考程度に見てください。`);
    }
    const cal = calibration(decisions);
    if (cal.n >= 5 && cal.bias !== null) {
      if (cal.bias > 0.1) out.push(`自信が高めに出る傾向があります（平均の自信度${pct(cal.meanP)}に対し、実際の成功率は${pct(cal.rate)}）。`);
      else if (cal.bias < -0.1) out.push(`自信が控えめに出る傾向があります（平均の自信度${pct(cal.meanP)}に対し、実際の成功率は${pct(cal.rate)}）。`);
      else out.push(`自信度と実際の成功率はおおむね合っています（${pct(cal.meanP)} と ${pct(cal.rate)}）。`);
      if (cal.brier > cal.brierBase) out.push("Brierスコアが「常に平均の成功率を答える」より悪い状態です。自信度の付け方に、まだ情報が乗っていない可能性があります。");
    }
    const labels = { matrix: "基準", gut: "直感", ai: "AI" };
    for (const voice of ["matrix", "gut", "ai"]) {
      const v = voiceStats(decisions, voice);
      if (v.agree.n >= 3 && v.disagree.n >= 3) {
        const diff = v.agree.rate - v.disagree.rate;
        if (!overlap(v.agree, v.disagree)) {
          out.push(`${labels[voice]}に従った時の成功率は、従わなかった時より${diff > 0 ? "高く" : "低く"}出ています（区間が重なっていません）。`);
        } else {
          out.push(`${labels[voice]}に従った時と従わなかった時の差は、偶然の範囲かもしれません（区間が重なっています）。`);
        }
      }
    }
    const sw = switchStats(decisions);
    if (sw.followedAI.n >= 2 && sw.keptGut.n >= 2) {
      out.push(`直感とAIが割れた${sw.total}件のうち、AIに乗り換えた時の成功は${sw.followedAI.good}/${sw.followedAI.n}件、直感を貫いた時は${sw.keptGut.good}/${sw.keptGut.n}件です。`);
    }
    return out;
  }

  const api = {
    ymd, addDays, status, isDecided, isReviewed, outcomeOf, weightedScores, matrixPick, pickOf,
    wilson, voiceStats, switchStats, calibration, dueReviews, lockRate, findings,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Stats = api;
})(typeof window !== "undefined" ? window : globalThis);
