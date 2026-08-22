/**
 * Checkpoint store: lesson runs, teaching plans, checkpoint jobs, artifacts,
 * note-update requests, and commit results.
 *
 * This is the durable outbox for the whole pipeline. Reads/writes here support
 * the checkpoint state machine (captured -> processing -> memory_committed ->
 * note_applied -> completed) and recovery scans.
 */

import type { Db } from "./sqlite.ts";
import type {
	CheckpointJob,
	CheckpointStatus,
	CommitResult,
	LessonRun,
	NoteUpdateRequest,
	TeachingArtifact,
	TeachingPlan,
} from "../domain/types.ts";
import { now } from "../domain/ids.ts";

type Row = Record<string, unknown>;

function rowToJob(r: Row): CheckpointJob {
	return {
		id: r.id as string,
		identityKey: r.identity_key as string,
		userId: r.user_id as string,
		sessionId: r.session_id as string,
		lessonRunId: r.lesson_run_id as string,
		planId: r.plan_id as string,
		moduleTitle: r.module_title as string,
		goalRefs: JSON.parse(r.goal_refs as string) as string[],
		reason: r.reason as string,
		fromEntryId: r.from_entry_id as string,
		toEntryId: (r.to_entry_id as string | null) ?? undefined,
		status: r.status as CheckpointStatus,
		attemptCount: r.attempt_count as number,
		leaseUntil: (r.lease_until as string | null) ?? undefined,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
	};
}

function rowToRun(r: Row): LessonRun {
	return {
		id: r.id as string,
		userId: r.user_id as string,
		sessionId: r.session_id as string,
		target: r.target as string,
		planId: (r.plan_id as string | null) ?? undefined,
		status: r.status as LessonRun["status"],
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
	};
}

const TERMINAL: CheckpointStatus[] = ["completed"];

export class CheckpointStore {
	private readonly db: Db;

	constructor(db: Db) {
		this.db = db;
	}

	// ---- lesson runs --------------------------------------------------------

	insertLessonRun(run: LessonRun): void {
		this.db
			.prepare(
				`INSERT INTO lesson_runs (id, user_id, session_id, target, plan_id, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(run.id, run.userId, run.sessionId, run.target, run.planId ?? null, run.status, run.createdAt, run.updatedAt);
	}

	setLessonPlan(lessonRunId: string, planId: string): void {
		this.db
			.prepare("UPDATE lesson_runs SET plan_id = ?, updated_at = ? WHERE id = ?")
			.run(planId, now(), lessonRunId);
	}

	setLessonStatus(lessonRunId: string, status: LessonRun["status"]): void {
		this.db.prepare("UPDATE lesson_runs SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), lessonRunId);
	}

	getActiveLessonRun(sessionId: string): LessonRun | undefined {
		const r = this.db
			.prepare("SELECT * FROM lesson_runs WHERE session_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
			.get(sessionId) as Row | undefined;
		return r ? rowToRun(r) : undefined;
	}

	getLessonRun(id: string): LessonRun | undefined {
		const r = this.db.prepare("SELECT * FROM lesson_runs WHERE id = ?").get(id) as Row | undefined;
		return r ? rowToRun(r) : undefined;
	}

	// ---- teaching plans -----------------------------------------------------

	insertPlan(plan: TeachingPlan): void {
		this.db
			.prepare("INSERT INTO teaching_plans (id, lesson_run_id, data, created_at) VALUES (?, ?, ?, ?)")
			.run(plan.id, plan.lessonRunId, JSON.stringify(plan), plan.createdAt);
	}

	getPlan(id: string): TeachingPlan | undefined {
		const r = this.db.prepare("SELECT data FROM teaching_plans WHERE id = ?").get(id) as Row | undefined;
		return r ? (JSON.parse(r.data as string) as TeachingPlan) : undefined;
	}

	// ---- checkpoint jobs ----------------------------------------------------

	/** Find an existing job by its deterministic identity key. */
	findJobByIdentity(identityKey: string): CheckpointJob | undefined {
		const r = this.db.prepare("SELECT * FROM checkpoint_jobs WHERE identity_key = ?").get(identityKey) as
			| Row
			| undefined;
		return r ? rowToJob(r) : undefined;
	}

	getJob(id: string): CheckpointJob | undefined {
		const r = this.db.prepare("SELECT * FROM checkpoint_jobs WHERE id = ?").get(id) as Row | undefined;
		return r ? rowToJob(r) : undefined;
	}

	insertJob(job: CheckpointJob): void {
		this.db
			.prepare(
				`INSERT INTO checkpoint_jobs
				 (id, identity_key, user_id, session_id, lesson_run_id, plan_id, module_title, goal_refs, reason,
				  from_entry_id, to_entry_id, status, attempt_count, lease_until, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				job.id,
				job.identityKey,
				job.userId,
				job.sessionId,
				job.lessonRunId,
				job.planId,
				job.moduleTitle,
				JSON.stringify(job.goalRefs),
				job.reason,
				job.fromEntryId,
				job.toEntryId ?? null,
				job.status,
				job.attemptCount,
				job.leaseUntil ?? null,
				job.createdAt,
				job.updatedAt,
			);
	}

	setJobToEntry(id: string, toEntryId: string): void {
		this.db.prepare("UPDATE checkpoint_jobs SET to_entry_id = ?, updated_at = ? WHERE id = ?").run(toEntryId, now(), id);
	}

	setJobStatus(id: string, status: CheckpointStatus): void {
		this.db.prepare("UPDATE checkpoint_jobs SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
	}

	/** Mark processing with a lease and bump the attempt counter. */
	leaseJob(id: string, leaseUntil: string): void {
		this.db
			.prepare(
				"UPDATE checkpoint_jobs SET status = 'processing', lease_until = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?",
			)
			.run(leaseUntil, now(), id);
	}

	/** Whether this run already produced a checkpoint (MVP: one per run). */
	hasCheckpointForRun(lessonRunId: string, sessionId: string): boolean {
		const r = this.db
			.prepare("SELECT COUNT(*) AS c FROM checkpoint_jobs WHERE lesson_run_id = ? AND session_id = ?")
			.get(lessonRunId, sessionId) as Row;
		return (r.c as number) > 0;
	}

	/** All non-terminal jobs for a session (recovery + status). */
	listPendingJobs(sessionId: string): CheckpointJob[] {
		const placeholders = TERMINAL.map(() => "?").join(", ");
		const rows = this.db
			.prepare(
				`SELECT * FROM checkpoint_jobs WHERE session_id = ? AND status NOT IN (${placeholders}) ORDER BY created_at`,
			)
			.all(sessionId, ...TERMINAL) as Row[];
		return rows.map(rowToJob);
	}

	/**
	 * Jobs eligible to run now: captured, or memory_committed (note retry), or a
	 * processing job whose lease expired. Excludes needs_review (awaits user).
	 */
	listRunnableJobs(sessionId: string, nowTs: string): CheckpointJob[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM checkpoint_jobs
				 WHERE session_id = ?
				   AND to_entry_id IS NOT NULL
				   AND ( status IN ('captured', 'memory_committed', 'note_applied')
				         OR (status = 'processing' AND (lease_until IS NULL OR lease_until < ?)) )
				 ORDER BY created_at`,
			)
			.all(sessionId, nowTs) as Row[];
		return rows.map(rowToJob);
	}

	// ---- teaching artifacts -------------------------------------------------

	saveArtifact(artifact: TeachingArtifact): void {
		this.db
			.prepare("INSERT OR REPLACE INTO teaching_artifacts (checkpoint_id, data) VALUES (?, ?)")
			.run(artifact.checkpointId, JSON.stringify(artifact));
	}

	getArtifact(checkpointId: string): TeachingArtifact | undefined {
		const r = this.db.prepare("SELECT data FROM teaching_artifacts WHERE checkpoint_id = ?").get(checkpointId) as
			| Row
			| undefined;
		return r ? (JSON.parse(r.data as string) as TeachingArtifact) : undefined;
	}

	// ---- note update requests ----------------------------------------------

	saveNoteUpdateRequest(req: NoteUpdateRequest): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO note_update_requests (checkpoint_id, knowledge_unit_id, source_state_version)
				 VALUES (?, ?, ?)`,
			)
			.run(req.checkpointId, req.knowledgeUnitId, req.sourceStateVersion);
	}

	listNoteUpdateRequests(checkpointId: string): NoteUpdateRequest[] {
		const rows = this.db
			.prepare("SELECT * FROM note_update_requests WHERE checkpoint_id = ?")
			.all(checkpointId) as Row[];
		return rows.map((r) => ({
			checkpointId: r.checkpoint_id as string,
			knowledgeUnitId: r.knowledge_unit_id as string,
			sourceStateVersion: r.source_state_version as number,
		}));
	}

	// ---- commit results -----------------------------------------------------

	saveCommitResult(result: CommitResult): void {
		this.db
			.prepare("INSERT OR REPLACE INTO commit_results (checkpoint_id, data) VALUES (?, ?)")
			.run(result.checkpointId, JSON.stringify(result));
	}

	getCommitResult(checkpointId: string): CommitResult | undefined {
		const r = this.db.prepare("SELECT data FROM commit_results WHERE checkpoint_id = ?").get(checkpointId) as
			| Row
			| undefined;
		return r ? (JSON.parse(r.data as string) as CommitResult) : undefined;
	}
}
