/**
 * Note store: NotePatchJob outbox + the knowledgeUnitId -> note-file mapping.
 *
 * The mapping is derived from note frontmatter (`knowledgeUnitIds`) but cached in
 * SQLite for fast lookup. The actual Markdown bytes live on disk and are owned by
 * the Note Patch Applier; this store never writes Markdown.
 */

import type { Db } from "./sqlite.ts";
import type { NoteMeta, NotePatch, NotePatchJob, NotePatchStatus } from "../domain/types.ts";
import { now } from "../domain/ids.ts";

type Row = Record<string, unknown>;

function rowToPatchJob(r: Row): NotePatchJob {
	return {
		id: r.id as string,
		checkpointId: r.checkpoint_id as string,
		noteId: r.note_id as string,
		knowledgeUnitId: r.knowledge_unit_id as string,
		sourceStateVersion: r.source_state_version as number,
		patch: JSON.parse(r.patch as string) as NotePatch,
		status: r.status as NotePatchStatus,
		createdAt: r.created_at as string,
		appliedAt: (r.applied_at as string | null) ?? undefined,
	};
}

export class NoteStore {
	private readonly db: Db;

	constructor(db: Db) {
		this.db = db;
	}

	// ---- note meta (mapping) ------------------------------------------------

	upsertNoteMeta(meta: NoteMeta): void {
		this.db
			.prepare(
				`INSERT INTO note_meta (id, topic_node_id, knowledge_unit_ids, path, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   topic_node_id = excluded.topic_node_id,
				   knowledge_unit_ids = excluded.knowledge_unit_ids,
				   path = excluded.path,
				   updated_at = excluded.updated_at`,
			)
			.run(meta.id, meta.topicNodeId, JSON.stringify(meta.knowledgeUnitIds), meta.path, meta.updatedAt);
	}

	getNoteMeta(id: string): NoteMeta | undefined {
		const r = this.db.prepare("SELECT * FROM note_meta WHERE id = ?").get(id) as Row | undefined;
		return r ? this.rowToMeta(r) : undefined;
	}

	/** Find the note that owns a knowledge unit, if any. */
	findNoteForUnit(knowledgeUnitId: string): NoteMeta | undefined {
		// knowledge_unit_ids is a JSON array; match the quoted token to avoid
		// substring collisions (e.g. "js-event" matching "js-event-loop").
		const rows = this.db.prepare("SELECT * FROM note_meta").all() as Row[];
		for (const r of rows) {
			const ids = JSON.parse(r.knowledge_unit_ids as string) as string[];
			if (ids.includes(knowledgeUnitId)) return this.rowToMeta(r);
		}
		return undefined;
	}

	findNoteForTopic(topicNodeId: string): NoteMeta | undefined {
		const r = this.db.prepare("SELECT * FROM note_meta WHERE topic_node_id = ? LIMIT 1").get(topicNodeId) as
			| Row
			| undefined;
		return r ? this.rowToMeta(r) : undefined;
	}

	private rowToMeta(r: Row): NoteMeta {
		return {
			id: r.id as string,
			topicNodeId: r.topic_node_id as string,
			knowledgeUnitIds: JSON.parse(r.knowledge_unit_ids as string) as string[],
			path: r.path as string,
			updatedAt: r.updated_at as string,
		};
	}

	// ---- note patch jobs (outbox) ------------------------------------------

	/** Idempotent insert: returns the existing job for the same identity if present. */
	upsertPatchJob(job: NotePatchJob): NotePatchJob {
		const existing = this.db
			.prepare(
				"SELECT * FROM note_patch_jobs WHERE checkpoint_id = ? AND knowledge_unit_id = ? AND source_state_version = ?",
			)
			.get(job.checkpointId, job.knowledgeUnitId, job.sourceStateVersion) as Row | undefined;
		if (existing) return rowToPatchJob(existing);

		this.db
			.prepare(
				`INSERT INTO note_patch_jobs
				 (id, checkpoint_id, note_id, knowledge_unit_id, source_state_version, patch, status, created_at, applied_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				job.id,
				job.checkpointId,
				job.noteId,
				job.knowledgeUnitId,
				job.sourceStateVersion,
				JSON.stringify(job.patch),
				job.status,
				job.createdAt,
				job.appliedAt ?? null,
			);
		return job;
	}

	setPatchJobStatus(id: string, status: NotePatchStatus, appliedAt?: string): void {
		this.db
			.prepare("UPDATE note_patch_jobs SET status = ?, applied_at = ? WHERE id = ?")
			.run(status, appliedAt ?? null, id);
	}

	listPatchJobsForCheckpoint(checkpointId: string): NotePatchJob[] {
		const rows = this.db
			.prepare("SELECT * FROM note_patch_jobs WHERE checkpoint_id = ? ORDER BY created_at")
			.all(checkpointId) as Row[];
		return rows.map(rowToPatchJob);
	}

	listPendingPatchJobs(): NotePatchJob[] {
		const rows = this.db
			.prepare("SELECT * FROM note_patch_jobs WHERE status = 'pending' ORDER BY created_at")
			.all() as Row[];
		return rows.map(rowToPatchJob);
	}

	countDirtyNotes(): number {
		const r = this.db
			.prepare("SELECT COUNT(*) AS c FROM note_patch_jobs WHERE status IN ('pending', 'conflict')")
			.get() as Row;
		return r.c as number;
	}
}
