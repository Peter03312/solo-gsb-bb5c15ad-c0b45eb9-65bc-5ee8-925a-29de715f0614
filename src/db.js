'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'cueboard.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('sm', 'operator')),
  position   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 当前可编辑草稿（全局只有一份）
CREATE TABLE IF NOT EXISTS draft_cues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  position   TEXT NOT NULL,
  planned_start INTEGER NOT NULL,   -- 当日 00:00 起的分钟数
  duration   INTEGER NOT NULL,      -- 分钟
  row_ver    INTEGER NOT NULL DEFAULT 1,
  UNIQUE(code)
);

CREATE TABLE IF NOT EXISTS draft_deps (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_cue  INTEGER NOT NULL REFERENCES draft_cues(id) ON DELETE CASCADE,
  to_cue    INTEGER NOT NULL REFERENCES draft_cues(id) ON DELETE CASCADE,
  UNIQUE(from_cue, to_cue)
);

-- 已发布的只读联排版本
CREATE TABLE IF NOT EXISTS rehearsal_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version_no INTEGER NOT NULL UNIQUE,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS published_cues (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id      INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref         INTEGER NOT NULL,          -- 指向当时的 draft cue id
  code            TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  position        TEXT NOT NULL,
  planned_start   INTEGER NOT NULL,
  duration        INTEGER NOT NULL,
  UNIQUE(version_id, cue_ref)
);

CREATE TABLE IF NOT EXISTS published_deps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id  INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  from_ref    INTEGER NOT NULL,
  to_ref      INTEGER NOT NULL,
  UNIQUE(version_id, from_ref, to_ref)
);

-- 现场登记（每个已发布提示项一行，随发布创建）
CREATE TABLE IF NOT EXISTS registrations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref        INTEGER NOT NULL,
  position       TEXT NOT NULL,
  actual_start   INTEGER,                   -- 实际开始（分钟）
  actual_end     INTEGER,                   -- 实际完成（分钟）
  estimated_end  INTEGER,                   -- 预计结束（分钟）
  row_ver        INTEGER NOT NULL DEFAULT 1,
  updated_by     TEXT,
  updated_at     TEXT,
  UNIQUE(version_id, cue_ref)
);

-- 舞监现场登记更正历史（一次更正可能产生级联两条）
CREATE TABLE IF NOT EXISTS registration_corrections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref        INTEGER NOT NULL,
  field          TEXT NOT NULL CHECK (field IN ('actual_start', 'actual_end', 'estimated_end')),
  old_value      INTEGER,                   -- 更正前（分钟），NULL 表示原本未登记
  new_value      INTEGER,                   -- 更正后（分钟），NULL 表示清除
  reason         TEXT NOT NULL,
  cascaded       INTEGER NOT NULL DEFAULT 0,-- 1：清除开始时级联清除完成
  group_id       INTEGER,                   -- 同一次更正：级联行指向主行 id；主行为 NULL（排序用 COALESCE）
  corrected_by   TEXT NOT NULL,
  corrected_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pcues_version ON published_cues(version_id);
CREATE INDEX IF NOT EXISTS idx_reg_version ON registrations(version_id);
CREATE INDEX IF NOT EXISTS idx_corr_version ON registration_corrections(version_id);
`);

function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

module.exports = { db, getMeta, setMeta, DB_PATH };
