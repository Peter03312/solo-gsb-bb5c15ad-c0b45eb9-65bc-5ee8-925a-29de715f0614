'use strict';

// 所有时刻均以「当日 00:00 起的分钟数」表示，输入输出统一为 HH:MM。

function pad2(n) { return String(n).padStart(2, '0'); }

function timeToMin(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function minToTime(v) {
  if (v === null || v === undefined) return null;
  const m = ((v % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/**
 * 拓扑排序 + 环检测（DFS，确定性顺序：按 id 升序）。
 * cues: [{id}], deps: [{from, to}]（from 为前置，to 为后项）
 * 返回 { order: [id], cycle: [id, ...] | null }
 */
function topoAnalyze(cues, deps) {
  const ids = cues.map((c) => c.id).sort((a, b) => a - b);
  const adj = new Map();
  ids.forEach((id) => adj.set(id, []));
  for (const d of deps) {
    if (adj.has(d.from) && adj.has(d.to)) adj.get(d.from).push(d.to);
  }
  adj.forEach((list) => list.sort((a, b) => a - b));

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(ids.map((id) => [id, WHITE]));
  const stack = [];
  let cycle = null;

  function dfs(u) {
    if (cycle) return;
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u)) {
      if (color.get(v) === GRAY) {
        const idx = stack.indexOf(v);
        cycle = stack.slice(idx).concat(v);
        return;
      }
      if (color.get(v) === WHITE) dfs(v);
      if (cycle) return;
    }
    stack.pop();
    color.set(u, BLACK);
  }

  for (const id of ids) {
    if (color.get(id) === WHITE) dfs(id);
    if (cycle) break;
  }

  if (cycle) return { order: null, cycle };

  const order = [];
  const done = new Set();
  function visit(u) {
    if (done.has(u)) return;
    for (const v of adj.get(u)) visit(v);
    done.add(u);
    order.push(u);
  }
  ids.forEach(visit); // post-order：反转后保证前置在前、后项在后
  order.reverse();
  return { order, cycle: null };
}

function halfOpenOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * 发布前计划校验。
 * cues: [{id, code, position, plannedStart, duration}]
 * deps: [{from, to}]
 * 返回 { ok, errors: [{ type, message, codes: [] }] }
 */
function validatePlan(cues, deps) {
  const errors = [];
  const byId = new Map(cues.map((c) => [c.id, c]));

  // 1) 依赖关系环
  const { cycle } = topoAnalyze(cues, deps);
  if (cycle) {
    errors.push({
      type: 'CYCLE',
      codes: cycle.map((id) => (byId.get(id) || {}).code || `#${id}`),
      message: `前置依赖存在环：${cycle.map((id) => (byId.get(id) || {}).code || `#${id}`).join(' → ')}`,
    });
  }

  // 2) 前置项计划结束不晚于后项计划开始
  const depBad = [];
  for (const d of deps) {
    const a = byId.get(d.from);
    const b = byId.get(d.to);
    if (!a || !b) continue;
    if (a.plannedStart + a.duration > b.plannedStart) {
      depBad.push({ a, b });
    }
  }
  if (depBad.length) {
    errors.push({
      type: 'DEP_ORDER',
      codes: [...new Set(depBad.flatMap((x) => [x.a.code, x.b.code]))],
      message: depBad
        .map(({ a, b }) => {
          const aEnd = minToTime(a.plannedStart + a.duration);
          return `前置「${a.code}」计划结束 ${aEnd} 晚于后项「${b.code}」开始 ${minToTime(b.plannedStart)}`;
        })
        .join('；'),
    });
  }

  // 3) 同岗位时段不重叠（半开区间：首尾相接允许）
  const byPosition = new Map();
  for (const c of cues) {
    if (!byPosition.has(c.position)) byPosition.set(c.position, []);
    byPosition.get(c.position).push(c);
  }
  const overlapBad = [];
  for (const [position, list] of byPosition) {
    const sorted = [...list].sort((a, b) => a.plannedStart - b.plannedStart || a.id - b.id);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.plannedStart >= a.plannedStart + a.duration) continue;
        if (halfOpenOverlap(a.plannedStart, a.plannedStart + a.duration,
                            b.plannedStart, b.plannedStart + b.duration)) {
          overlapBad.push({ position, a, b });
        }
      }
    }
  }
  if (overlapBad.length) {
    errors.push({
      type: 'POSITION_OVERLAP',
      codes: [...new Set(overlapBad.flatMap((x) => [x.a.code, x.b.code]))],
      message: overlapBad
        .map(({ position, a, b }) =>
          `岗位「${position}」时段冲突：「${a.code}」(${minToTime(a.plannedStart)}-${minToTime(a.plannedStart + a.duration)}) 与「${b.code}」(${minToTime(b.plannedStart)}-${minToTime(b.plannedStart + b.duration)})`)
        .join('；'),
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 现场联排：结合登记的实际/预计时间重算尚未开始项。
 * publishedCues: [{id(=cueRef), code, title, position, plannedStart, duration}]
 * deps: [{from, to}]（以 cueRef 表示）
 * regs: Map/object keyed by cueRef -> {actualStart, actualEnd, estimatedEnd, rowVer, updatedBy, updatedAt}
 *
 * 返回 { cues: [...], conflicts: [{position,a,b,message}], orderProblem: null|message }
 */
function computeLive(publishedCues, deps, regMap) {
  const byId = new Map(publishedCues.map((c) => [c.id, c]));
  const preds = new Map();
  publishedCues.forEach((c) => preds.set(c.id, []));
  for (const d of deps) {
    if (preds.has(d.to) && byId.has(d.from)) preds.get(d.to).push(d.from);
  }

  const { order } = topoAnalyze(
    publishedCues.map((c) => ({ id: c.id })),
    deps.map((d) => ({ from: d.from, to: d.to }))
  );

  const calc = new Map();
  if (!order) {
    return { cues: [], conflicts: [], orderProblem: '已发布数据检测到依赖环，无法重算' };
  }

  for (const id of order) {
    const cue = byId.get(id);
    const r = regMap.get(id) || {};
    const as = r.actualStart ?? null;
    const ae = r.actualEnd ?? null;
    const ee = r.estimatedEnd ?? null;

    let status, schedStart, schedEnd, effStart;

    if (ae !== null) {
      status = 'DONE';
      schedStart = as;
      schedEnd = ae;
    } else if (as !== null) {
      status = 'RUNNING';
      schedStart = as;
      schedEnd = ee !== null ? ee : as + cue.duration;
    } else {
      status = 'PENDING';
      let start = cue.plannedStart; // 开始时刻不得早于原计划
      for (const p of preds.get(id)) {
        const pc = calc.get(p);
        if (pc) start = Math.max(start, pc.schedEnd);
      }
      effStart = start;
      schedStart = start;
      schedEnd = ee !== null ? ee : start + cue.duration;
    }

    calc.set(id, {
      ...cue,
      status,
      actualStart: as,
      actualEnd: ae,
      estimatedEnd: ee,
      schedStart,
      schedEnd,
      delayed: status === 'PENDING' && schedStart > cue.plannedStart,
      rowVer: r.rowVer ?? 1,
      updatedBy: r.updatedBy ?? null,
      updatedAt: r.updatedAt ?? null,
    });
  }

  // 顺延之后的岗位冲突：至少一方未完成
  const conflicts = [];
  const byPosition = new Map();
  for (const c of calc.values()) {
    if (!byPosition.has(c.position)) byPosition.set(c.position, []);
    byPosition.get(c.position).push(c);
  }
  for (const [position, list] of byPosition) {
    const sorted = [...list].sort((a, b) => a.schedStart - b.schedStart || a.id - b.id);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.schedStart >= a.schedEnd) continue;
        if (halfOpenOverlap(a.schedStart, a.schedEnd, b.schedStart, b.schedEnd)
            && (a.status !== 'DONE' || b.status !== 'DONE')) {
          conflicts.push({
            position,
            codes: [a.code, b.code],
            message: `岗位「${position}」执行时段冲突：「${a.code}」(${minToTime(a.schedStart)}-${minToTime(a.schedEnd)}) 与「${b.code}」(${minToTime(b.schedStart)}-${minToTime(b.schedEnd)})`,
          });
        }
      }
    }
  }

  // 按计划开始时间返回，便于现场阅读
  const cues = [...calc.values()].sort((a, b) => a.plannedStart - b.plannedStart || a.id - b.id);
  return { cues, conflicts, orderProblem: null };
}

module.exports = { timeToMin, minToTime, topoAnalyze, validatePlan, computeLive };
