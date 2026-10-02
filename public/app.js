'use strict';

const state = {
  me: null,
  positions: [],
  draft: null,
  live: null,
  versions: [],
  detail: null,
  editingCueId: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// ---------- API ----------

async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (res.status === 401) {
    showLogin();
    throw new Error(data?.message || '未登录');
  }
  if (!res.ok) {
    const err = new Error(data?.message || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data || {};
    throw err;
  }
  return data;
}

let alertTimer = null;
function alertBar(kind, message, ms = 5000) {
  const bar = $('#alert-bar');
  bar.className = `alert ${kind}`;
  bar.innerHTML = message;
  bar.hidden = false;
  clearTimeout(alertTimer);
  if (ms) alertTimer = setTimeout(() => { bar.hidden = true; }, ms);
}

function errorToHtml(err) {
  const d = err.data || {};
  let html = `<strong>${esc(err.message)}</strong>`;
  if (d.errors?.length) {
    html += '<ul>' + d.errors.map((e) => `<li>[${esc(e.type)}] ${esc(e.message)}</li>`).join('') + '</ul>';
  }
  if (d.currentVersion !== undefined) html += `<div class="muted">请刷新草稿获取最新数据后再提交。</div>`;
  return html;
}

// ---------- 登录 / 启动 ----------

function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
}

function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  const isSM = state.me.role === 'sm';
  const tabs = isSM
    ? [['draft', '草稿编辑'], ['live', '现场联排'], ['versions', '发布版本']]
    : [['live', '现场联排'], ['versions', '发布版本']];
  $('#tabs').innerHTML = tabs.map(([k, label], i) =>
    `<button data-tab="${k}" class="${i === 0 ? 'active' : ''}">${label}</button>`).join('');
  $('#user-tag').innerHTML =
    `<span class="role-tag ${isSM ? 'sm' : ''}">${isSM ? '舞监' : esc(state.me.position) + '执行'}</span>
     ${esc(state.me.displayName)}（${esc(state.me.username)}）`;
  switchTab(isSM ? 'draft' : 'live');
}

function switchTab(tab) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ['draft', 'live', 'versions'].forEach((t) => { $('#tab-' + t).hidden = t !== tab; });
  if (tab === 'draft') loadDraft().catch((e) => alertBar('error', errorToHtml(e)));
  if (tab === 'live') loadLive().catch((e) => alertBar('error', errorToHtml(e)));
  if (tab === 'versions') loadVersions().catch((e) => alertBar('error', errorToHtml(e)));
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#login-error').hidden = true;
  const fd = new FormData(ev.target);
  try {
    const { user } = await api('POST', '/api/login', {
      username: fd.get('username'), password: fd.get('password'),
    });
    state.me = user;
    showApp();
  } catch (e) {
    const box = $('#login-error');
    box.textContent = e.message;
    box.hidden = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  state.me = null;
  showLogin();
});

$('#tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});

// ---------- 舞监：草稿 ----------

async function loadDraft() {
  state.draft = await api('GET', '/api/draft');
  state.positions = state.draft.positions;
  renderDraft();
}

async function loadDraftFresh() {
  return api('GET', '/api/draft');
}

function cueLabel(c) {
  return `${c.code}${c.title ? ' ' + c.title : ''}（${c.position} ${c.plannedStartText}）`;
}

function renderValidation(v) {
  const panel = $('#validation-panel');
  if (v.ok) {
    panel.innerHTML = `<div class="val-ok">✅ 计划校验通过：前置顺序、同岗位时段、依赖环检查均无问题，可以发布。</div>`;
  } else {
    panel.innerHTML = `<div class="val-err"><strong>⚠ ${v.errors.length} 项冲突，无法发布：</strong><ul>${
      v.errors.map((e) => `<li>${esc(e.message)}</li>`).join('')
    }</ul></div>`;
  }
}

function renderDraft() {
  const d = state.draft;
  if (!d) return;
  $('#draft-ver').textContent = `（草稿版本号 v${d.version}）`;
  renderValidation(d.validation);

  const posSelect = $('#cue-position-select');
  posSelect.innerHTML = '<option value="">选择岗位</option>' +
    d.positions.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');

  const cueOptions = d.cues.map((c) => `<option value="${c.id}">${esc(cueLabel(c))}</option>`).join('');
  $('#dep-from').innerHTML = cueOptions;
  $('#dep-to').innerHTML = cueOptions;

  const cueMap = new Map(d.cues.map((c) => [c.id, c]));
  const predsOf = new Map(d.cues.map((c) => [c.id, []]));
  for (const dep of d.deps) {
    if (predsOf.has(dep.to)) predsOf.get(dep.to).push(dep.from);
  }

  $('#draft-cue-tbody').innerHTML = d.cues.map((c) => {
    const preds = predsOf.get(c.id).map((pid) => esc(cueMap.get(pid)?.code || `#${pid}`)).join('、') || '—';
    const end = c.plannedStart + c.duration;
    return `<tr>
      <td><strong>${esc(c.code)}</strong></td>
      <td>${esc(c.title)}</td>
      <td>${esc(c.position)}</td>
      <td class="mono">${c.plannedStartText}</td>
      <td class="mono">${c.duration} 分</td>
      <td class="mono">${minText(end)}</td>
      <td>${preds}</td>
      <td>
        <button class="ghost tiny" data-act="edit-cue" data-id="${c.id}">编辑</button>
        <button class="ghost tiny" data-act="del-cue" data-id="${c.id}" data-code="${esc(c.code)}">删除</button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" class="muted">暂无提示项，请在左侧新增。</td></tr>`;

  $('#dep-list').innerHTML = d.deps.map((dep) => {
    const a = cueMap.get(dep.from), b = cueMap.get(dep.to);
    return `<div class="dep-item">
      <span>${a ? esc(a.code) : '#' + dep.from} → ${b ? esc(b.code) : '#' + dep.to}</span>
      <button class="ghost tiny" data-act="del-dep" data-id="${dep.id}">移除</button>
    </div>`;
  }).join('') || '<div class="muted">暂无前置关系。</div>';

  $('#publish-result').innerHTML = '';
}

function minText(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function resetCueForm() {
  const form = $('#cue-form');
  form.reset();
  form.elements.id.value = '';
  form.elements.rowVersion.value = '';
  $('#cue-form-title').textContent = '新增提示项';
  $('#cue-submit').textContent = '新增';
  $('#cue-cancel').hidden = true;
  state.editingCueId = null;
}

$('#cue-cancel').addEventListener('click', resetCueForm);

$('#cue-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const fd = new FormData(f);
  const payload = {
    version: state.draft.version,
    code: fd.get('code'),
    title: fd.get('title'),
    position: fd.get('position'),
    plannedStartText: fd.get('plannedStartText'),
    duration: Number(fd.get('duration')),
  };
  const id = fd.get('id');
  try {
    if (id) {
      payload.rowVersion = Number(fd.get('rowVersion'));
      state.draft = (await api('PUT', `/api/draft/cues/${id}`, payload));
      alertBar('ok', '提示项已更新，草稿版本号 v' + state.draft.version);
    } else {
      state.draft = await api('POST', '/api/draft/cues', payload);
      alertBar('ok', '提示项已新增，草稿版本号 v' + state.draft.version);
    }
    resetCueForm();
    renderDraft();
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409) loadDraft().then(renderDraft).catch(() => {});
  }
});

$('#draft-cue-tbody').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'edit-cue') {
    const c = state.draft.cues.find((x) => x.id === Number(btn.dataset.id));
    if (!c) return;
    const f = $('#cue-form');
    f.elements.id.value = c.id;
    f.elements.rowVersion.value = c.rowVersion;
    f.elements.code.value = c.code;
    f.elements.title.value = c.title;
    f.elements.position.value = c.position;
    f.elements.plannedStartText.value = c.plannedStartText;
    f.elements.duration.value = c.duration;
    $('#cue-form-title').textContent = `编辑提示项 ${c.code}`;
    $('#cue-submit').textContent = '保存修改';
    $('#cue-cancel').hidden = false;
    state.editingCueId = c.id;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (act === 'del-cue') {
    if (!confirm(`确认删除提示项「${btn.dataset.code}」及其相关前置关系？`)) return;
    try {
      state.draft = await api('DELETE', `/api/draft/cues/${btn.dataset.id}?version=${state.draft.version}`);
      alertBar('ok', '已删除，草稿版本号 v' + state.draft.version);
      if (state.editingCueId === Number(btn.dataset.id)) resetCueForm();
      renderDraft();
    } catch (e) {
      alertBar('error', errorToHtml(e));
      if (e.status === 409) loadDraft().then(renderDraft).catch(() => {});
    }
  }
});

$('#dep-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const from = Number(fd.get('from'));
  const to = Number(fd.get('to'));
  if (from === to) return alertBar('error', '请选择不同的前置与后项提示项');
  try {
    state.draft = await api('POST', '/api/draft/deps', { version: state.draft.version, from, to });
    alertBar('ok', '前置关系已添加，草稿版本号 v' + state.draft.version);
    renderDraft();
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409) loadDraft().then(renderDraft).catch(() => {});
  }
});

$('#dep-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act="del-dep"]');
  if (!btn) return;
  try {
    state.draft = await api('DELETE', `/api/draft/deps/${btn.dataset.id}?version=${state.draft.version}`);
    alertBar('ok', '前置关系已移除，草稿版本号 v' + state.draft.version);
    renderDraft();
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409) loadDraft().then(renderDraft).catch(() => {});
  }
});

$('#publish-btn').addEventListener('click', async () => {
  if (!state.draft) return;
  if (!state.draft.validation.ok) {
    alertBar('error', '当前草稿存在冲突项，请先根据上方红色提示修正后再发布。');
    return;
  }
  if (!confirm('确认发布只读联排版本？发布后岗位将依据新版本登记。')) return;
  try {
    const result = await api('POST', '/api/publish', {
      version: state.draft.version,
      note: $('#publish-note').value.trim(),
    });
    $('#publish-note').value = '';
    alertBar('ok', `🎉 已发布联排第 ${result.versionNo} 版（版本号校验通过），草稿版本已推进，请刷新视图`);
    state.draft = await loadDraftFresh();
    renderDraft();
  } catch (e) {
    if (e.status === 422) alertBar('error', errorToHtml(e), 12000);
    else alertBar('error', errorToHtml(e));
    // 发布失败也拉取最新草稿（可能版本已变化）
    loadDraft().then(renderDraft).catch(() => {});
  }
});

// 发布成功后草稿版本号已推进，由调用处重新拉取。

$('#draft-reload').addEventListener('click', () =>
  loadDraft().then(() => alertBar('ok', '草稿已刷新')).catch((e) => alertBar('error', errorToHtml(e))));

// ---------- 现场联排 ----------

async function loadLive() {
  const data = await api('GET', '/api/live');
  state.live = data.version;
  renderLive();
}

function statusBadge(s) {
  if (s === 'DONE') return '<span class="badge done">已完成</span>';
  if (s === 'RUNNING') return '<span class="badge running">已开始</span>';
  return '<span class="badge pending">未开始</span>';
}

function renderConflicts(conflicts) {
  const box = $('#live-conflicts');
  if (!conflicts?.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="conflict-banner"><strong>⚠ 顺延后岗位冲突 ${conflicts.length} 项：</strong><ul>${
    conflicts.map((c) => `<li>${esc(c.message)}</li>`).join('')
  }</ul></div>`;
}

function renderLive() {
  const v = state.live;
  if (!v) {
    $('#live-meta').innerHTML = '<div class="muted">尚未发布任何联排版本，请等待舞监发布。</div>';
    $('#live-conflicts').innerHTML = '';
    $('#live-tbody').innerHTML = '';
    return;
  }
  $('#live-meta').innerHTML =
    `<strong>第 ${v.versionNo} 版</strong>　${esc(v.note)}　<span class="muted">发布于 ${esc(v.createdAt)}</span>
     ${v.isLatest ? '<span class="latest-tag">当前执行版本</span>' : '<span class="latest-tag" style="background:#999">非最新版本</span>'}`;
  renderConflicts(v.conflicts);

  const isOp = state.me.role === 'operator';
  const myPos = state.me.position;
  const canReg = isOp && v.isLatest;

  $('#live-tbody').innerHTML = v.cues.map((c) => {
    const mine = isOp && c.position === myPos;
    const delayed = c.delayed ? `<div class="delayed">已顺延</div>` : '';
    let reg = '<span class="muted">—</span>';
    if (canReg && mine) {
      reg = renderRegControls(c);
    } else if (mine && isOp) {
      reg = '<span class="muted">本岗位（版本已归档）</span>';
    }
    return `<tr class="${mine ? 'own-row' : ''}" data-cue="${c.id}">
      <td><strong>${esc(c.code)}</strong></td>
      <td>${esc(c.title)}</td>
      <td>${esc(c.position)}</td>
      <td class="mono">${c.plannedStartText} - ${minText(c.plannedStart + c.duration)}</td>
      <td class="mono">${c.schedStartText}${delayed}</td>
      <td class="mono">${c.schedEndText}</td>
      <td>${statusBadge(c.status)}<div class="muted">v${c.rowVer}</div></td>
      <td class="mono">${c.actualStartText ?? '—'}</td>
      <td class="mono">${c.actualEndText ?? '—'}</td>
      <td class="mono">${c.estimatedEndText ?? '—'}</td>
      <td>${reg}</td>
    </tr>`;
  }).join('');
}

function renderRegControls(c) {
  const common = `data-cue="${c.id}" data-ver="${c.rowVer}" data-version-id="${state.live.id}"`;
  let buttons = '';
  if (c.status === 'PENDING') {
    buttons = `
      <div class="reg-actions">
        <input type="time" data-role="start-time" title="留空取当前时间" />
        <button class="primary tiny" data-reg="start" ${common}>开始</button>
      </div>
      <div class="reg-actions">
        <input type="time" data-role="est-time" />
        <button class="ghost tiny" data-reg="estimate" ${common}>预计结束</button>
      </div>`;
  } else if (c.status === 'RUNNING') {
    buttons = `
      <div class="reg-actions">
        <input type="time" data-role="end-time" title="留空取当前时间" />
        <button class="primary tiny" data-reg="complete" ${common}>完成</button>
      </div>
      <div class="reg-actions">
        <input type="time" data-role="est-time" value="${c.estimatedEndText ?? ''}" />
        <button class="ghost tiny" data-reg="estimate" ${common}>改预计</button>
      </div>`;
  } else {
    buttons = '<span class="muted">已完成</span>';
  }
  return buttons;
}

$('#live-tbody').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-reg]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const action = btn.dataset.reg;
  const payload = {
    versionId: Number(btn.dataset.versionId),
    cueRef: Number(btn.dataset.cue),
    rowVersion: Number(btn.dataset.ver),
    action,
  };
  if (action === 'start') payload.time = $('[data-role="start-time"]', tr)?.value || null;
  if (action === 'complete') payload.time = $('[data-role="end-time"]', tr)?.value || null;
  if (action === 'estimate') {
    payload.estimatedEndText = $('[data-role="est-time"]', tr)?.value || '';
    if (!payload.estimatedEndText) return alertBar('error', '请先填写预计结束时间');
  }
  try {
    const data = await api('POST', '/api/registrations', payload);
    state.live = data.version;
    const hasConflict = data.version.conflicts.length > 0;
    alertBar(hasConflict ? 'error' : 'ok',
      hasConflict
        ? `登记成功，但出现 ${data.version.conflicts.length} 项顺延岗位冲突，请查看红色提示。`
        : '登记成功，重算结果已更新。');
    renderLive();
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409) loadLive().catch(() => {});
  }
});

$('#live-reload').addEventListener('click', () =>
  loadLive().then(() => alertBar('ok', '已刷新')).catch((e) => alertBar('error', errorToHtml(e))));

// ---------- 已发布版本回看 ----------

async function loadVersions() {
  const data = await api('GET', '/api/versions');
  state.versions = data.versions;
  renderVersions();
}

function renderVersions() {
  $('#versions-tbody').innerHTML = state.versions.map((v) =>
    `<tr>
      <td><strong>第 ${v.versionNo} 版</strong></td>
      <td>${esc(v.note)}</td>
      <td class="mono">${esc(v.createdAt)}</td>
      <td>${v.cueCount}</td>
      <td>${v.regCount}</td>
      <td><button class="ghost tiny" data-act="view-version" data-id="${v.id}">回看</button></td>
    </tr>`).join('')
    || '<tr><td colspan="6" class="muted">暂无已发布版本。</td></tr>';
}

$('#versions-tbody').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act="view-version"]');
  if (!btn) return;
  try {
    state.detail = await api('GET', `/api/versions/${btn.dataset.id}`);
    renderDetail();
  } catch (e) { alertBar('error', errorToHtml(e)); }
});

function renderDetail() {
  const v = state.detail;
  if (!v) return;
  const conflictHtml = v.conflicts.length
    ? `<div class="conflict-banner"><strong>冲突 ${v.conflicts.length} 项：</strong><ul>${
        v.conflicts.map((c) => `<li>${esc(c.message)}</li>`).join('')}</ul></div>` : '';
  $('#version-detail').innerHTML = `
    <div class="panel">
      <h3>回看：第 ${v.versionNo} 版（只读）${v.isLatest ? '<span class="latest-tag">当前执行版本</span>' : ''}</h3>
      <div class="muted">${esc(v.note)} · 发布于 ${esc(v.createdAt)}</div>
    </div>
    ${conflictHtml}
    <div class="panel"><div class="table-wrap"><table>
      <thead><tr><th>编号</th><th>说明</th><th>岗位</th><th>计划</th><th>重算开始</th><th>重算结束</th><th>状态</th><th>实际开始</th><th>实际完成</th><th>预计结束</th><th>登记人/时间</th></tr></thead>
      <tbody>${v.cues.map((c) => `<tr>
        <td><strong>${esc(c.code)}</strong></td>
        <td>${esc(c.title)}</td>
        <td>${esc(c.position)}</td>
        <td class="mono">${c.plannedStartText} - ${minText(c.plannedStart + c.duration)}</td>
        <td class="mono">${c.schedStartText}${c.delayed ? '<div class="delayed">顺延</div>' : ''}</td>
        <td class="mono">${c.schedEndText}</td>
        <td>${statusBadge(c.status)}</td>
        <td class="mono">${c.actualStartText ?? '—'}</td>
        <td class="mono">${c.actualEndText ?? '—'}</td>
        <td class="mono">${c.estimatedEndText ?? '—'}</td>
        <td class="muted">${c.updatedBy ? esc(c.updatedBy) + '<br>' + esc(c.updatedAt || '') : '—'}</td>
      </tr>`).join('')}</tbody>
    </table></div></div>`;
}

$('#versions-reload').addEventListener('click', () =>
  loadVersions().then(() => alertBar('ok', '版本列表已刷新')).catch((e) => alertBar('error', errorToHtml(e))));

// ---------- 启动 ----------

(async function boot() {
  try {
    const data = await fetch('/api/me').then((r) => r.json());
    if (data.user) {
      state.me = data.user;
      state.positions = data.positions || [];
      showApp();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
})();
