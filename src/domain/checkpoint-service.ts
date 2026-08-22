/**
 * Checkpoint service: deterministic identity + job lifecycle helpers.
 *
 * The Actor's `learning_checkpoint` tool creates a durable job here (not formal
 * memory). Identity is a stable hash so re-processing the same message range
 * returns the existing job rather than creating a duplicate (design §9.1).
 */

import type { CheckpointJob } from "./types.ts";
import type { CheckpointStore } from "../storage/checkpoint-store.ts";
import { newId, now, stableKey } from "./ids.ts";

/**
 * checkpoint identity = sessionId + fromEntryId + toEntryId + planId +
 * moduleTitle + goalRefs. toEntryId may be absent at capture time; it is folded
 * in once finalized so the *finalized* range is what dedups downstream retries.
 */
export function checkpointIdentity(parts: {
	sessionId: string;
	fromEntryId: string;
	toEntryId?: string;
	planId: string;
	moduleTitle: string;
	goalRefs: string[];
}): string {
	return stableKey(
		parts.sessionId,
		parts.fromEntryId,
		parts.toEntryId ?? "",
		parts.planId,
		parts.moduleTitle,
		[...parts.goalRefs].sort().join(","),
	);
}

export interface CreateCheckpointInput {
	userId: string;
	sessionId: string;
	lessonRunId: string;
	planId: string;
	moduleTitle: string;
	goalRefs: string[];
	reason: string;
	fromEntryId: string;
}

export class CheckpointService {
	private readonly store: CheckpointStore;

	constructor(store: CheckpointStore) {
		this.store = store;
	}

	/**
	 * Create a captured checkpoint job for the current run. `toEntryId` is left
	 * open and finalized at agent_settled. Returns the existing job if an
	 * identical capture already exists (idempotent).
	 */
	capture(input: CreateCheckpointInput): CheckpointJob {
		const identityKey = checkpointIdentity({
			sessionId: input.sessionId,
			fromEntryId: input.fromEntryId,
			toEntryId: undefined,
			planId: input.planId,
			moduleTitle: input.moduleTitle,
			goalRefs: input.goalRefs,
		});

		const existing = this.store.findJobByIdentity(identityKey);
		if (existing) return existing;

		const ts = now();
		const job: CheckpointJob = {
			id: newId("cp"),
			identityKey,
			userId: input.userId,
			sessionId: input.sessionId,
			lessonRunId: input.lessonRunId,
			planId: input.planId,
			moduleTitle: input.moduleTitle,
			goalRefs: input.goalRefs,
			reason: input.reason,
			fromEntryId: input.fromEntryId,
			toEntryId: undefined,
			status: "captured",
			attemptCount: 0,
			createdAt: ts,
			updatedAt: ts,
		};
		this.store.insertJob(job);
		return job;
	}

	/**
	 * Finalize the message range of a captured job at agent settle time. Records
	 * the last assistant entry as `toEntryId`. No-op if already finalized.
	 */
	finalizeRange(jobId: string, toEntryId: string): void {
		const job = this.store.getJob(jobId);
		if (!job || job.toEntryId) return;
		this.store.setJobToEntry(jobId, toEntryId);
	}

	/** Whether the current run may still create a checkpoint (MVP: one per run). */
	runCanCheckpoint(lessonRunId: string, sessionId: string): boolean {
		return !this.store.hasCheckpointForRun(lessonRunId, sessionId);
	}

	/** Take a processing lease on a job. Default lease 5 minutes. */
	lease(jobId: string, leaseMs = 5 * 60_000): void {
		const until = new Date(Date.now() + leaseMs).toISOString();
		this.store.leaseJob(jobId, until);
	}
}
