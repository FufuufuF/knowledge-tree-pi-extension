/**
 * SQLite connection + schema.
 *
 * Uses Node's built-in `node:sqlite` (`DatabaseSync`). WAL mode with short
 * transactions per the design (section 10). This module owns the schema and a
 * single `transaction()` helper; higher-level stores build on the raw handle.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

const SCHEMA_VERSION = 1;

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT REFERENCES knowledge_nodes(id),
  name         TEXT NOT NULL,
  definition   TEXT NOT NULL,
  learning_goals TEXT,            -- JSON string[]
  assessable   INTEGER NOT NULL DEFAULT 1,
  norm_name    TEXT NOT NULL,     -- normalized name for keyword matching
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON knowledge_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_norm   ON knowledge_nodes(norm_name);

CREATE TABLE IF NOT EXISTS user_knowledge_states (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  knowledge_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
  exposure          TEXT NOT NULL,
  mastery           TEXT NOT NULL,
  misconceptions    TEXT NOT NULL DEFAULT '[]', -- JSON Misconception[]
  evidence_ids      TEXT NOT NULL DEFAULT '[]', -- JSON string[]
  next_teaching_hint TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  last_studied_at   TEXT,
  last_assessed_at  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(user_id, knowledge_node_id)
);

CREATE TABLE IF NOT EXISTS learning_evidence (
  id                TEXT PRIMARY KEY,
  observation_id    TEXT NOT NULL UNIQUE,
  user_id           TEXT NOT NULL,
  knowledge_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
  session_id        TEXT NOT NULL,
  turn_id           TEXT NOT NULL,
  source            TEXT NOT NULL,
  summary           TEXT NOT NULL,
  result            TEXT NOT NULL,
  prompted          INTEGER NOT NULL DEFAULT 0,
  confidence        REAL NOT NULL DEFAULT 0,
  observed_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_node ON learning_evidence(user_id, knowledge_node_id);

CREATE TABLE IF NOT EXISTS lesson_runs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  target      TEXT NOT NULL,
  plan_id     TEXT,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lesson_session ON lesson_runs(session_id, status);

CREATE TABLE IF NOT EXISTS teaching_plans (
  id            TEXT PRIMARY KEY,
  lesson_run_id TEXT NOT NULL REFERENCES lesson_runs(id),
  data          TEXT NOT NULL,   -- JSON TeachingPlan
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoint_jobs (
  id            TEXT PRIMARY KEY,
  identity_key  TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  lesson_run_id TEXT NOT NULL,
  plan_id       TEXT NOT NULL,
  module_title  TEXT NOT NULL,
  goal_refs     TEXT NOT NULL,   -- JSON string[]
  reason        TEXT NOT NULL,
  from_entry_id TEXT NOT NULL,
  to_entry_id   TEXT,
  status        TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_until   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoint_status ON checkpoint_jobs(status);
CREATE INDEX IF NOT EXISTS idx_checkpoint_session ON checkpoint_jobs(session_id);

CREATE TABLE IF NOT EXISTS teaching_artifacts (
  checkpoint_id TEXT PRIMARY KEY REFERENCES checkpoint_jobs(id),
  data          TEXT NOT NULL    -- JSON TeachingArtifact
);

CREATE TABLE IF NOT EXISTS note_update_requests (
  checkpoint_id     TEXT NOT NULL REFERENCES checkpoint_jobs(id),
  knowledge_unit_id TEXT NOT NULL,
  source_state_version INTEGER NOT NULL,
  PRIMARY KEY (checkpoint_id, knowledge_unit_id)
);

CREATE TABLE IF NOT EXISTS note_patch_jobs (
  id                TEXT PRIMARY KEY,
  checkpoint_id     TEXT NOT NULL REFERENCES checkpoint_jobs(id),
  note_id           TEXT NOT NULL,
  knowledge_unit_id TEXT NOT NULL,
  source_state_version INTEGER NOT NULL,
  patch             TEXT NOT NULL,   -- JSON NotePatch
  status            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  applied_at        TEXT,
  UNIQUE(checkpoint_id, knowledge_unit_id, source_state_version)
);
CREATE INDEX IF NOT EXISTS idx_notepatch_status ON note_patch_jobs(status);

CREATE TABLE IF NOT EXISTS commit_results (
  checkpoint_id TEXT PRIMARY KEY REFERENCES checkpoint_jobs(id),
  data          TEXT NOT NULL   -- JSON CommitResult
);

CREATE TABLE IF NOT EXISTS note_meta (
  id                TEXT PRIMARY KEY,
  topic_node_id     TEXT NOT NULL,
  knowledge_unit_ids TEXT NOT NULL,  -- JSON string[]
  path              TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notemeta_topic ON note_meta(topic_node_id);
`;

/**
 * Open (creating if needed) the Byte Mentor database at `path`, apply pragmas and
 * the schema. Idempotent — safe to call once per process.
 */
export function openDatabase(path: string): Db {
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec("PRAGMA synchronous = NORMAL;");
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
	db.exec(SCHEMA);
	return db;
}

/**
 * Run `fn` inside a single IMMEDIATE transaction. Commits on success, rolls back
 * on any throw. `node:sqlite` is synchronous, so `fn` must be synchronous too —
 * this is exactly what the Committer's atomic write needs.
 */
export function transaction<T>(db: Db, fn: () => T): T {
	db.exec("BEGIN IMMEDIATE;");
	try {
		const result = fn();
		db.exec("COMMIT;");
		return result;
	} catch (err) {
		try {
			db.exec("ROLLBACK;");
		} catch {
			// ignore rollback failure; original error is what matters
		}
		throw err;
	}
}

export { SCHEMA_VERSION };
