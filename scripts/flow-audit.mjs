// 看板流量审计 v2（只读，2026-10-29；已按独立复核修正口径）。
// 用法：node scripts/flow-audit.mjs
// 口径修正：①按日分布含 0 值日；②峰值同时给日终/连续两种；③cycle time 区分原始与剔除"秒关闭/创建即完成"；
// ④Little 定律用同一总体（全部到达卡、未完成按删失到快照；并给活跃日速率）；⑤会话目录全量计数；
// ⑥归档滞后不再当"机制指标"（归档只发生在少数时点，单列事件时刻）；⑦卡片构成只做稳定口径（artifacts vs work）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAY = 86400000;
const OFF = 8 * 3600000;
const dayKey = t => new Date(t + OFF).toISOString().slice(0, 10);
const now = Date.now();
const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh-kanban', 'data.json'), 'utf8'));
const cards = data.cards;
const acts = data.activities || [];
const byCard = new Map();
for (const a of acts) { if (!byCard.has(a.cardId)) byCard.set(a.cardId, []); byCard.get(a.cardId).push(a); }
const archivedAt = c => c.archivedAt || (byCard.get(c.id) || []).find(a => a.type === 'archived')?.at;
const createdEv = acts.filter(a => a.type === 'created').sort((a, b) => a.at - b.at);
const pct = (arr, p) => { if (!arr.length) return NaN; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.ceil(a.length * p) - 1))]; };
const avg = arr => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : NaN;
const dayText = t => new Date(t + OFF).toISOString().slice(0, 16).replace('T', ' ');

// 1) 到达/完成/归档/活跃：按日（含 0 值日）
const days = [];
const firstDay = dayKey(Math.min(...cards.map(c => c.createdAt)));
const lastDay = dayKey(Math.max(...cards.map(c => c.completedAt || c.updatedAt)));
for (let t = new Date(firstDay + 'T00:00:00+08:00').getTime(); dayKey(t) <= lastDay; t += DAY) days.push(dayKey(t));
const eodSeries = days.map(dk => {
  const eod = new Date(dk + 'T23:59:59.999+08:00').getTime();
  return {
    day: dk,
    arrival: cards.filter(c => dayKey(c.createdAt) === dk).length,
    completed: cards.filter(c => c.completedAt && dayKey(c.completedAt) === dk).length,
    archived: cards.filter(c => archivedAt(c) && dayKey(archivedAt(c)) === dk).length,
    active: cards.filter(c => c.createdAt <= eod && !(archivedAt(c) && archivedAt(c) <= eod)).length,
    inflight: cards.filter(c => c.createdAt <= eod && !(c.completedAt && c.completedAt <= eod) && !(archivedAt(c) && archivedAt(c) <= eod)).length,
    doneUnarchived: cards.filter(c => c.completedAt && c.completedAt <= eod && c.status === 'done' && !(archivedAt(c) && archivedAt(c) <= eod)).length,
  };
});
for (const r of eodSeries) console.log('day', r.day, 'arrival', r.arrival, 'completed', r.completed, 'archived', r.archived, 'active', r.active, 'inflight', r.inflight, 'doneUnarchived', r.doneUnarchived);

// 连续口径峰值（created +1 / archived -1）
const events = [...cards.map(c => ({ t: c.createdAt, v: +1 })), ...cards.filter(c => archivedAt(c)).map(c => ({ t: archivedAt(c), v: -1 }))].sort((a, b) => a.t - b.t);
let cur = 0, peak = { n: -1, t: 0 };
for (const e of events) { cur += e.v; if (cur > peak.n) peak = { n: cur, t: e.t }; }
console.log('\n连续口径峰值 active =', peak.n, '@', dayText(peak.t));

// 2) 当前
const live = cards.filter(c => !archivedAt(c));
const byStatus = live.reduce((a, c) => (a[c.status] = (a[c.status] || 0) + 1, a), {});
const inflightNow = live.filter(c => !['done', 'canceled'].includes(c.status));
const startedUnfinished = inflightNow.filter(c => (byCard.get(c.id) || []).some(a => a.type !== 'created'));
console.log('当前 active=', live.length, JSON.stringify(byStatus), '| 未终态=', inflightNow.length, '其中已开始未完成=', startedUnfinished.length, '| archived=', cards.length - live.length);

// 3) 归档事件时点
const archEvents = cards.filter(c => archivedAt(c)).map(c => archivedAt(c)).sort((a, b) => a - b);
const archTimes = [...new Set(archEvents.map(t => Math.floor(t / 1000)))];
console.log('归档事件时点数=', archTimes.length, '归档总数=', archEvents.length, '| 最后一批同秒=', archEvents.filter(t => Math.floor(t / 1000) === archTimes.at(-1)).length);

// 4) cycle time：原始 / 剔除秒关与创建即 done / 全量停留（含未完成，删失到快照）
const completed = cards.filter(c => c.completedAt && c.createdAt);
const rawCycle = completed.map(c => (c.completedAt - c.createdAt) / DAY);
const createdDone = completed.filter(c => (byCard.get(c.id) || []).some(a => a.type === 'created' && a.data?.status === 'done'));
const sane = completed.filter(c => (c.completedAt - c.createdAt) > 60000 && !createdDone.includes(c)).map(c => (c.completedAt - c.createdAt) / DAY);
const sojournAll = cards.map(c => ((c.completedAt || now) - c.createdAt) / DAY);
console.log('\ncycle raw n=', rawCycle.length, 'p50=', pct(rawCycle, .5)?.toFixed(2), 'p90=', pct(rawCycle, .9)?.toFixed(2));
console.log('cycle 剔除<60s与创建即done n=', sane.length, 'p50=', pct(sane, .5)?.toFixed(2), 'p90=', pct(sane, .9)?.toFixed(2), 'mean=', avg(sane).toFixed(2));
console.log('全量停留(含未完成) n=', sojournAll.length, 'p50=', pct(sojournAll, .5)?.toFixed(2), 'p90=', pct(sojournAll, .9)?.toFixed(2), 'mean=', avg(sojournAll).toFixed(2));

// 5) Little's law：同一总体
const activeDays = eodSeries.filter(r => r.arrival + r.completed + r.archived > 0).length;
const obsWip = avg(eodSeries.map(r => r.inflight));
const lambda9 = cards.length / eodSeries.length;
const lambdaActive = cards.length / activeDays;
const meanSojourn = avg(sojournAll);
console.log('\nLittle: 观测 EOD 在途均值=', obsWip.toFixed(2), '| 9天到达率=', lambda9.toFixed(2), '| 活跃日到达率=', lambdaActive.toFixed(2));
console.log('同一总体 λ×平均停留 =', (lambda9 * meanSojourn).toFixed(2), '(9天) /', (lambdaActive * meanSojourn).toFixed(2), '(活跃日)');
console.log('完成卡平均周期(旧口径)=', avg(rawCycle).toFixed(2), '→ 只算完成卡的 W 被低估，Little 不能这么用');

// 6) aging backlog + 从未被推进
const backlog = inflightNow.filter(c => c.status === 'backlog');
const ages = backlog.map(c => (now - c.createdAt) / DAY);
const untouched = backlog.filter(c => (byCard.get(c.id) || []).every(a => a.type === 'created'));
console.log('\nbacklog=', backlog.length, '中位年龄=', pct(ages, .5)?.toFixed(2), '>7d=', ages.filter(x => x > 7).length, '| 从未被推进(只有 created)=', untouched.length);

// 7) 批量建卡簇（同 actor ≤10 分钟链式）
const byActor = new Map();
for (const e of createdEv) { const k = (e.actor?.id || e.actor?.name || 'unknown') + '|' + (e.actor?.kind || '?'); if (!byActor.has(k)) byActor.set(k, []); byActor.get(k).push(e); }
const clusters = [];
for (const [actor, evs] of byActor) {
  let g = [evs[0]];
  const flush = () => { if (g.length >= 3) clusters.push({ actor, n: g.length, from: g[0].at, to: g.at(-1).at }); };
  for (let i = 1; i < evs.length; i++) { if (evs[i].at - evs[i - 1].at <= 600000) g.push(evs[i]); else { flush(); g = [evs[i]]; } }
  flush();
}
clusters.sort((a, b) => b.n - a.n);
console.log('\n批量簇(>=3, 同 actor<=10min)=', clusters.length);
for (const c of clusters) console.log(' ', c.n, '张', dayText(c.from), '→', dayText(c.to), c.actor);

// 8) artifacts（种子/记账/验证脚手架）
const seed = cards.filter(c => (c.labels || []).includes('示例'));
const ledger = createdDone;
const scaffold = cards.filter(c => /\[v013|【临时|^自检|probe|（临时|\[demo|verify\]/i.test(c.title));
const artifactIds = new Set([...seed, ...ledger, ...scaffold].map(c => c.id));
console.log('\nartifact 卡：seed=', seed.length, 'ledger(创建即done)=', ledger.length, 'scaffold=', scaffold.length, '去重合计=', artifactIds.size, '/', cards.length);

// 9) 审批（近邻秩分位，标注回填与静默窗口）
const dec = fs.readFileSync(path.join(os.homedir(), '.dsh-kanban', 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const req = dec.filter(e => e.type === 'approval_requested');
const res = dec.filter(e => e.type === 'approval_resolved');
const waits = [];
for (const r of req) { const m = res.find(m => m.approvalId === r.approvalId && m.cardId === r.cardId && m.at >= r.at); if (m) waits.push({ min: (m.at - r.at) / 60000, backfill: r.source === 'backfill' }); }
const w = waits.map(x => x.min);
console.log('\n审批 n=', waits.length, 'p50=', pct(w, .5)?.toFixed(1), 'p90=', pct(w, .9)?.toFixed(1), 'max=', Math.max(...w).toFixed(1), '| 回填=', waits.filter(x => x.backfill).length);

// 10) 会话全量
const root = path.join(os.homedir(), '.dsh', 'sessions');
let dirs = 0;
for (const ws of fs.readdirSync(root)) { try { dirs += fs.readdirSync(path.join(root, ws)).filter(n => /^(session-|[0-9a-f]{8}-|ytd-)/.test(n)).length; } catch {} }
const wsdata = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'storages', 'workspace.json'), 'utf8'));
const cardSessions = new Set(cards.flatMap(c => c.sessionIds || []));
const kanbanWs = Object.values(wsdata.tables.workspaces || {}).find(r => r.path.includes('dsh kanban'));
console.log('\n会话目录=', dirs, '| 卡片引用去重会话=', cardSessions.size, '| kanban registry 会话=', kanbanWs?.sessionIds.length, '| 已归档会话=', (wsdata.global.archivedSessionIds || []).length);
