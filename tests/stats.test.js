"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../stats.js");

function decision(over) {
  return {
    id: "d", createdAt: "2026-10-01", question: "q", context: "",
    options: ["A", "B", "C"], criteria: [], scores: [],
    gut: { pick: -1, lockedAt: "" },
    ai: { source: "", pick: -1, note: "", recordedAt: "" },
    final: { pick: -1, date: "", confidence: 0, reason: "" },
    review: { due: "", outcome: "", lesson: "", date: "" },
    ...over,
  };
}
const reviewed = (finalPick, confidence, outcome, over) =>
  decision({ final: { pick: finalPick, date: "2026-10-02", confidence, reason: "" }, review: { due: "2026-10-10", outcome, lesson: "", date: "2026-10-11" }, ...over });

test("weightedScores / matrixPick: 重み付き平均で最高点を選ぶ。同点・基準なしは結論を出さない", () => {
  const d = decision({
    criteria: [{ name: "効果", weight: 5 }, { name: "コスト", weight: 1 }],
    scores: [[5, 3, 1], [1, 5, 5]],
  });
  const s = S.weightedScores(d);
  assert.ok(Math.abs(s[0] - (5 * 5 + 1 * 1) / 6) < 1e-9);
  assert.equal(S.matrixPick(d), 0);
  const tie = decision({ criteria: [{ name: "x", weight: 3 }], scores: [[4, 4, 2]] });
  assert.equal(S.matrixPick(tie), -1);
  assert.equal(S.matrixPick(decision({})), -1);
});

test("wilson: 件数が少ないと区間が広く、極端な値にならない", () => {
  assert.deepEqual(S.wilson(0, 0), { low: 0, high: 1 });
  const small = S.wilson(3, 3);
  assert.ok(small.low < 0.5 && small.high === 1);
  const big = S.wilson(80, 100);
  assert.ok(big.low > 0.7 && big.high < 0.88);
  assert.ok(S.wilson(5, 10).low < S.wilson(50, 100).low);
});

test("status: 検討中 / 結果待ち / 振り返り済み", () => {
  assert.equal(S.status(decision({})), "considering");
  assert.equal(S.status(decision({ final: { pick: 0, date: "", confidence: 60, reason: "" } })), "waiting");
  assert.equal(S.status(reviewed(0, 60, "good")), "reviewed");
});

test("voiceStats: 従った時／従わなかった時の成功率を分けて数える（反事実は数えない）", () => {
  const ds = [
    reviewed(0, 70, "good", { gut: { pick: 0, lockedAt: "2026-10-01" } }),
    reviewed(0, 70, "good", { gut: { pick: 0, lockedAt: "2026-10-01" } }),
    reviewed(1, 70, "bad", { gut: { pick: 0, lockedAt: "2026-10-01" } }),
    reviewed(2, 70, "good", { gut: { pick: -1, lockedAt: "" } }), // 直感なしは対象外
  ];
  const v = S.voiceStats(ds, "gut");
  assert.equal(v.agree.n, 2);
  assert.equal(v.agree.good, 2);
  assert.equal(v.disagree.n, 1);
  assert.equal(v.disagree.good, 0);
});

test("switchStats: 直感とAIが割れた判断だけを対象にする", () => {
  const mk = (final, outcome) => reviewed(final, 60, outcome, { gut: { pick: 0, lockedAt: "x" }, ai: { source: "s", pick: 1, note: "", recordedAt: "" } });
  const ds = [mk(1, "good"), mk(1, "bad"), mk(0, "good"), mk(2, "bad"),
    reviewed(0, 60, "good", { gut: { pick: 0, lockedAt: "x" }, ai: { source: "s", pick: 0, note: "", recordedAt: "" } })];
  const s = S.switchStats(ds);
  assert.equal(s.total, 4);
  assert.equal(s.followedAI.n, 2);
  assert.equal(s.followedAI.good, 1);
  assert.equal(s.keptGut.n, 1);
  assert.equal(s.other.n, 1);
});

test("calibration: 自信度と成功率のずれ・Brierスコア", () => {
  const ds = [
    reviewed(0, 90, "good"), reviewed(0, 90, "bad"), reviewed(0, 90, "bad"), reviewed(0, 90, "bad"),
    reviewed(0, 60, "good"), reviewed(0, 60, "good"),
  ];
  const c = S.calibration(ds);
  assert.equal(c.n, 6);
  assert.ok(c.bias > 0.1, "過信の判定");
  const hi = c.buckets.find((b) => b.lo === 90);
  assert.equal(hi.n, 4);
  assert.ok(Math.abs(hi.rate - 0.25) < 1e-9);
  assert.ok(c.brier > 0 && c.brier < 1);
  assert.equal(S.calibration([]).n, 0);
});

test("dueReviews: 期限が来ていて結果が未記入のものだけ、期限順", () => {
  const waiting = (due) => decision({ final: { pick: 0, date: "2026-10-01", confidence: 60, reason: "" }, review: { due, outcome: "", lesson: "", date: "" } });
  const ds = [waiting("2026-10-20"), waiting("2026-10-10"), waiting("2026-11-30"), reviewed(0, 60, "good"), decision({})];
  const due = S.dueReviews(ds, new Date(2026, 9, 29));
  assert.deepEqual(due.map((d) => d.review.due), ["2026-10-10", "2026-10-20"]);
});

test("lockRate: 決定した判断のうち、事前に直感をロックした割合", () => {
  assert.equal(S.lockRate([]), null);
  const ds = [reviewed(0, 60, "good", { gut: { pick: 0, lockedAt: "2026-10-01" } }), reviewed(0, 60, "good"), decision({})];
  assert.equal(S.lockRate(ds), 0.5);
});

test("findings: 件数が少ないと断定せず、過信を言葉にする", () => {
  assert.match(S.findings([])[0], /5件未満/);
  const ds = [];
  for (let i = 0; i < 6; i++) ds.push(reviewed(0, 90, i < 2 ? "good" : "bad"));
  const text = S.findings(ds).join("\n");
  assert.match(text, /自信が高めに出る/);
});
