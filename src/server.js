'use strict';

process.env.TZ = process.env.TZ || 'Asia/Shanghai';

const path = require('path');
const express = require('express');
const session = require('express-session');

const { db, getMeta, setMeta } = require('./db');
const { verifyPassword } = require('./auth');
const { init } = require('./initdb');
const { timeToMin, minToTime, validatePlan, computeLive } = require('./scheduling');

init();

const app = express();
app.use(express.json());
app.use(
  session({
    name: 'cueboard.sid',
    secret: process.env.SESSION_SECRET || 'cueboard-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 },
  })
);

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ---------- 辅助 ----------

function currentMinute() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function positionsList() {
  try {
    return JSON.parse(getMeta('positions', '[]'));
  } catch {
    return [];
  }
}

function requireAuth(req, res, next) {
  if (!req.session.user) return next(new ApiError(401, 'UNAUTHORIZED', '尚未登录'));
  next();
}

function requireSM(req, res, next) {
  if (!req.session.user) return next(new ApiError(401, 'UNAUTHORIZED', '尚未登录'));
  if (req.session.user.role !== 'sm') return next(new ApiError(403, 'FORBIDDEN', '仅舞监可执行该操作'));
  next();
}

function checkDraftVersion(bodyVersion) {
  const current = Number(getMeta('draft_version', '0'));
  if (bodyVersion === undefined || bodyVersion === null || Number(bodyVersion) !== current) {
    throw new ApiError(409, 'VERSION_CONFLICT',
      `草稿已被他人修改：当前版本号为 ${current}，提交基于 ${bodyVersion ?? '空'}，请刷新后重试`,
      { currentVersion: current, submittedVersion: bodyVersion ?? null });
  }
  return current;
}

function bumpDraftVersion() {
  const v = Number(getMeta('draft_version', '0')) + 1;
  setMeta('draft_version', v);
  return v;
}

function loadDraftCues() {
  return db.prepare(
    'SELECT id, code, title, position, planned_start, duration, row_ver FROM draft_cues ORDER BY id'
  ).all().map((c) => ({
    id: c.id, code: c.code, title: c.title, position: c.position,
    plannedStart: c.planned_start, duration: c.duration, rowVersion: c.row_ver,
  }));
}

function loadDraftDeps() {
  return db.prepare('SELECT id, from_cue, to_cue FROM draft_deps ORDER BY id').all()
    .map((d) => ({ id: d.id, from: d.from_cue, to: d.to_cue }));
}

function draftPayload() {
  const cues = loadDraftCues();
  const deps = loadDraftDeps();
  const validation = validatePlan(cues, deps);
  return {
    version: Number(getMeta('draft_version', '0')),
    positions: positionsList(),
    cues: cues.map((c) => ({ ...c, plannedStartText: minToTime(c.plannedStart) })),
    deps,
    validation,
  };
}

function cueInputFromBody(body) {
  const code = String(body.code || '').trim();
  const title = String(body.title || '').trim();
  const position = String(body.position || '').trim();
  const startText = String(body.plannedStartText || '').trim();
  const plannedStart = timeToMin(startText);
  const duration = Number(body.duration);
  if (!code) throw new ApiError(400, 'BAD_INPUT', '提示项编号不能为空');
  if (!position) throw new ApiError(400, 'BAD_INPUT', `「${code}」岗位不能为空`);
  if (!positionsList().includes(position)) throw new ApiError(400, 'BAD_INPUT', `岗位「${position}」不在已配置岗位列表中`);
  if (plannedStart === null) throw new ApiError(400, 'BAD_INPUT', `「${code}」计划开始时间格式应为 HH:MM`);
  if (!Number.isInteger(duration) || duration <= 0) throw new ApiError(400, 'BAD_INPUT', `「${code}」时长必须为正整数分钟`);
  return { code, title, position, plannedStart, duration };
}

function versionPayload(versionRow) {
  const cues = db.prepare(
    `SELECT cue_ref, code, title, position, planned_start, duration
     FROM published_cues WHERE version_id = ? ORDER BY id`
  ).all(versionRow.id).map((c) => ({
    id: c.cue_ref, code: c.code, title: c.title, position: c.position,
    plannedStart: c.planned_start, duration: c.duration,
  }));
  const deps = db.prepare(
    'SELECT from_ref, to_ref FROM published_deps WHERE version_id = ? ORDER BY id'
  ).all(versionRow.id).map((d) => ({ from: d.from_ref, to: d.to_ref }));

  const regRows = db.prepare(
    'SELECT * FROM registrations WHERE version_id = ?'
  ).all(versionRow.id);
  const regMap = new Map();
  for (const r of regRows) {
    regMap.set(r.cue_ref, {
      actualStart: r.actual_start, actualEnd: r.actual_end,
      estimatedEnd: r.estimated_end, rowVer: r.row_ver,
      updatedBy: r.updated_by, updatedAt: r.updated_at,
    });
  }

  const live = computeLive(cues, deps, regMap);
  const latestId = (db.prepare('SELECT MAX(version_no) AS m FROM rehearsal_versions').get().m);
  return {
    id: versionRow.id,
    versionNo: versionRow.version_no,
    note: versionRow.note,
    createdAt: versionRow.created_at,
    isLatest: versionRow.version_no === latestId,
    cues: live.cues.map((c) => ({
      ...c,
      plannedStartText: minToTime(c.plannedStart),
      schedStartText: minToTime(c.schedStart),
      schedEndText: minToTime(c.schedEnd),
      actualStartText: minToTime(c.actualStart),
      actualEndText: minToTime(c.actualEnd),
      estimatedEndText: minToTime(c.estimatedEnd),
    })),
    conflicts: live.conflicts,
    orderProblem: live.orderProblem,
  };
}

// ---------- 认证 ----------

app.post('/api/login', (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) throw new ApiError(400, 'BAD_INPUT', '用户名与密码不能为空');
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!u || !verifyPassword(password, u.password_hash)) {
      throw new ApiError(401, 'BAD_CREDENTIALS', '用户名或密码错误');
    }
    req.session.user = { id: u.id, username: u.username, role: u.role, position: u.position, displayName: u.display_name };
    res.json({ user: req.session.user });
  } catch (e) { next(e); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null, positions: positionsList() });
});

// ---------- 舞监：草稿编辑 ----------

app.get('/api/draft', requireSM, (req, res, next) => {
  try { res.json(draftPayload()); } catch (e) { next(e); }
});

app.get('/api/draft/validate', requireSM, (req, res, next) => {
  try { res.json(validatePlan(loadDraftCues(), loadDraftDeps())); } catch (e) { next(e); }
});

app.post('/api/draft/cues', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(req.body.version);
    const fields = cueInputFromBody(req.body);
    const dup = db.prepare('SELECT 1 FROM draft_cues WHERE code = ?').get(fields.code);
    if (dup) throw new ApiError(400, 'BAD_INPUT', `编号「${fields.code}」已存在`);
    db.prepare(
      `INSERT INTO draft_cues(code, title, position, planned_start, duration)
       VALUES (@code, @title, @position, @plannedStart, @duration)`
    ).run(fields);
    bumpDraftVersion();
    res.status(201).json(draftPayload());
  } catch (e) { next(e); }
});

app.put('/api/draft/cues/:id', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(req.body.version);
    const id = Number(req.params.id);
    const cue = db.prepare('SELECT * FROM draft_cues WHERE id = ?').get(id);
    if (!cue) throw new ApiError(404, 'NOT_FOUND', '提示项不存在');
    if (Number(req.body.rowVersion) !== cue.row_ver) {
      throw new ApiError(409, 'ROW_VERSION_CONFLICT',
        `提示项「${cue.code}」已被修改：当前行版本 ${cue.row_ver}，提交基于 ${req.body.rowVersion}，请刷新后重试`,
        { currentVersion: Number(getMeta('draft_version', '0')), currentRowVersion: cue.row_ver });
    }
    const fields = cueInputFromBody(req.body);
    const dup = db.prepare('SELECT 1 FROM draft_cues WHERE code = ? AND id != ?').get(fields.code, id);
    if (dup) throw new ApiError(400, 'BAD_INPUT', `编号「${fields.code}」已存在`);
    db.prepare(
      `UPDATE draft_cues SET code=@code, title=@title, position=@position,
         planned_start=@plannedStart, duration=@duration, row_ver=row_ver+1 WHERE id=@id`
    ).run({ ...fields, id });
    bumpDraftVersion();
    res.json(draftPayload());
  } catch (e) { next(e); }
});

app.delete('/api/draft/cues/:id', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(Number(req.query.version));
    const id = Number(req.params.id);
    const cue = db.prepare('SELECT * FROM draft_cues WHERE id = ?').get(id);
    if (!cue) throw new ApiError(404, 'NOT_FOUND', '提示项不存在');
    db.prepare('DELETE FROM draft_cues WHERE id = ?').run(id); // 依赖通过外键级联删除
    bumpDraftVersion();
    res.json(draftPayload());
  } catch (e) { next(e); }
});

app.post('/api/draft/deps', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(req.body.version);
    const from = Number(req.body.from);
    const to = Number(req.body.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new ApiError(400, 'BAD_INPUT', '前置/后项编号无效');
    if (from === to) throw new ApiError(400, 'BAD_INPUT', '提示项不能以前置自身');
    const cues = db.prepare('SELECT id FROM draft_cues WHERE id IN (?, ?)').all(from, to);
    if (cues.length !== 2) throw new ApiError(404, 'NOT_FOUND', '前置或后项提示项不存在');
    const exists = db.prepare('SELECT 1 FROM draft_deps WHERE from_cue=? AND to_cue=?').get(from, to);
    if (exists) throw new ApiError(400, 'BAD_INPUT', '该前置关系已存在');
    db.prepare('INSERT INTO draft_deps(from_cue, to_cue) VALUES (?, ?)').run(from, to);
    bumpDraftVersion();
    res.status(201).json(draftPayload());
  } catch (e) { next(e); }
});

app.delete('/api/draft/deps/:id', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(Number(req.query.version));
    const id = Number(req.params.id);
    const info = db.prepare('DELETE FROM draft_deps WHERE id = ?').run(id);
    if (info.changes === 0) throw new ApiError(404, 'NOT_FOUND', '前置关系不存在');
    bumpDraftVersion();
    res.json(draftPayload());
  } catch (e) { next(e); }
});

// ---------- 舞监：发布只读联排版本 ----------

app.post('/api/publish', requireSM, (req, res, next) => {
  try {
    const submitted = req.body.version;
    const cues = loadDraftCues();
    const deps = loadDraftDeps();
    const validation = validatePlan(cues, deps);

    const result = db.transaction(() => {
      const current = Number(getMeta('draft_version', '0'));
      if (submitted === undefined || Number(submitted) !== current) {
        throw new ApiError(409, 'VERSION_CONFLICT',
          `草稿已被他人修改：当前版本号为 ${current}，提交基于 ${submitted ?? '空'}，请刷新后重试`,
          { currentVersion: current, submittedVersion: submitted ?? null });
      }
      if (!validation.ok) {
        throw new ApiError(422, 'PUBLISH_CONFLICT', '存在冲突项，无法发布联排版本', { errors: validation.errors });
      }
      const maxNo = db.prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM rehearsal_versions').get().m;
      const versionNo = maxNo + 1;
      const info = db.prepare('INSERT INTO rehearsal_versions(version_no, note) VALUES (?, ?)')
        .run(versionNo, String(req.body.note || `联排第 ${versionNo} 版`));
      const versionId = info.lastInsertRowid;

      const insCue = db.prepare(
        `INSERT INTO published_cues(version_id, cue_ref, code, title, position, planned_start, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insDep = db.prepare(
        'INSERT INTO published_deps(version_id, from_ref, to_ref) VALUES (?, ?, ?)'
      );
      const insReg = db.prepare(
        `INSERT INTO registrations(version_id, cue_ref, position) VALUES (?, ?, ?)`
      );
      for (const c of cues) insCue.run(versionId, c.id, c.code, c.title, c.position, c.plannedStart, c.duration);
      for (const d of deps) insDep.run(versionId, d.from, d.to);
      for (const c of cues) insReg.run(versionId, c.id, c.position);

      const v2 = current + 1; // 发布同时推进草稿版本号，过期页面必须刷新
      setMeta('draft_version', v2);
      return versionId;
    })();

    const row = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(result);
    res.status(201).json(versionPayload(row));
  } catch (e) { next(e); }
});

app.get('/api/versions', requireAuth, (req, res, next) => {
  try {
    const rows = db.prepare(
      `SELECT v.id, v.version_no, v.note, v.created_at,
              (SELECT COUNT(*) FROM registrations r WHERE r.version_id = v.id
                 AND (r.actual_start IS NOT NULL OR r.actual_end IS NOT NULL OR r.estimated_end IS NOT NULL)) AS reg_count,
              (SELECT COUNT(*) FROM published_cues p WHERE p.version_id = v.id) AS cue_count
       FROM rehearsal_versions v ORDER BY v.version_no DESC`
    ).all();
    res.json({
      versions: rows.map((r) => ({
        id: r.id, versionNo: r.version_no, note: r.note,
        createdAt: r.created_at, regCount: r.reg_count, cueCount: r.cue_count,
      })),
    });
  } catch (e) { next(e); }
});

app.get('/api/versions/:id', requireAuth, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(Number(req.params.id));
    if (!row) throw new ApiError(404, 'NOT_FOUND', '版本不存在');
    res.json(versionPayload(row));
  } catch (e) { next(e); }
});

app.get('/api/live', requireAuth, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM rehearsal_versions ORDER BY version_no DESC LIMIT 1').get();
    if (!row) return res.json({ version: null, message: '尚未发布任何联排版本' });
    res.json({ version: versionPayload(row) });
  } catch (e) { next(e); }
});

// ---------- 岗位：现场登记 ----------

app.post('/api/registrations', requireAuth, (req, res, next) => {
  try {
    if (req.session.user.role !== 'operator') throw new ApiError(403, 'FORBIDDEN', '仅执行岗位可登记');
    const versionId = Number(req.body.versionId);
    const cueRef = Number(req.body.cueRef);
    const rowVersion = Number(req.body.rowVersion);
    const action = String(req.body.action || '');

    const ver = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(versionId);
    if (!ver) throw new ApiError(404, 'NOT_FOUND', '联排版本不存在');
    const latest = db.prepare('SELECT id FROM rehearsal_versions ORDER BY version_no DESC LIMIT 1').get();
    if (!latest || latest.id !== ver.id) {
      throw new ApiError(409, 'VERSION_ARCHIVED',
        `第 ${ver.version_no} 版已不是当前执行版本（已有新版本发布），请刷新使用最新版本登记`);
    }

    const pc = db.prepare('SELECT * FROM published_cues WHERE version_id=? AND cue_ref=?').get(versionId, cueRef);
    if (!pc) throw new ApiError(404, 'NOT_FOUND', '提示项不存在于该版本');
    if (pc.position !== req.session.user.position) {
      throw new ApiError(403, 'FORBIDDEN', `「${pc.code}」属于岗位「${pc.position}」，当前账号只能登记本岗位提示项`);
    }

    const reg = db.prepare('SELECT * FROM registrations WHERE version_id=? AND cue_ref=?').get(versionId, cueRef);
    if (!reg) throw new ApiError(404, 'NOT_FOUND', '登记记录不存在');
    if (rowVersion !== reg.row_ver) {
      throw new ApiError(409, 'VERSION_CONFLICT',
        `「${pc.code}」登记已被更新：当前行版本 ${reg.row_ver}，提交基于 ${rowVersion}，请刷新后重试`,
        { currentRowVersion: reg.row_ver });
    }

    const parseOptTime = (v) => (v === undefined || v === null || v === '' ? null : timeToMin(v));
    let patch;
    const actor = req.session.user.displayName;
    const stamp = new Date().toLocaleString('sv-SE'); // YYYY-MM-DD HH:MM:SS

    if (action === 'start') {
      if (reg.actual_start !== null) throw new ApiError(400, 'BAD_STATE', `「${pc.code}」已登记实际开始`);
      const t = parseOptTime(req.body.time) ?? currentMinute();
      patch = { actual_start: t };
    } else if (action === 'estimate') {
      if (reg.actual_end !== null) throw new ApiError(400, 'BAD_STATE', `「${pc.code}」已完成，不能再修改预计结束`);
      const ee = parseOptTime(req.body.estimatedEndText);
      if (ee === null) throw new ApiError(400, 'BAD_INPUT', '请填写预计结束时间（HH:MM）');
      const lower = reg.actual_start !== null ? reg.actual_start : pc.planned_start;
      if (ee < lower) {
        throw new ApiError(400, 'BAD_INPUT',
          `预计结束 ${minToTime(ee)} 早于${reg.actual_start !== null ? '实际开始' : '原计划开始'} ${minToTime(lower)}`);
      }
      patch = { estimated_end: ee };
    } else if (action === 'complete') {
      if (reg.actual_start === null) throw new ApiError(400, 'BAD_STATE', `「${pc.code}」尚未登记实际开始，无法完成`);
      if (reg.actual_end !== null) throw new ApiError(400, 'BAD_STATE', `「${pc.code}」已完成`);
      const t = parseOptTime(req.body.time) ?? currentMinute();
      if (t < reg.actual_start) throw new ApiError(400, 'BAD_INPUT', `完成时刻 ${minToTime(t)} 早于实际开始 ${minToTime(reg.actual_start)}`);
      patch = { actual_end: t };
    } else {
      throw new ApiError(400, 'BAD_INPUT', '未知登记动作');
    }

    db.prepare(
      `UPDATE registrations SET ${Object.keys(patch).map((k) => `${k} = @${k}`).join(', ')},
         row_ver = row_ver + 1, updated_by = @updated_by, updated_at = @updated_at
       WHERE id = @id`
    ).run({ ...patch, updated_by: actor, updated_at: stamp, id: reg.id });

    res.json({ version: versionPayload(ver) });
  } catch (e) { next(e); }
});

// ---------- 静态页面与错误处理 ----------

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'BAD_JSON', message: '请求体不是合法 JSON' });
  }
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: '服务器内部错误' });
});

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`联排提示板已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
