/**
 * Shared extension runtime context.
 *
 * A single mutable object threaded through commands, hooks, and the actor tool.
 * Created lazily at session_start (never in the factory — two-phase init rule).
 */

import type { Model } from "@earendil-works/pi-ai";
import { Storage, defaultLayout } from "../storage/index.ts";
import { CheckpointService } from "../domain/checkpoint-service.ts";
import type { TeachingPlan } from "../domain/types.ts";

export interface ByteMentorContext {
	storage: Storage;
	checkpointService: CheckpointService;
	cwd: string;
	userId: string;
	/** Pi sessionId, set at session_start. */
	sessionId: string;
	/** Active lesson run id + plan, when learning mode is on. */
	activeLessonRunId?: string;
	activePlan?: TeachingPlan;
	/** Model used for isolated agents (Planner / Memory), resolved from ctx.model. */
	model?: Model<any>;
	/** Whether a checkpoint was already created in the current agent run. */
	checkpointThisRun: boolean;
	/** The checkpoint job id created in the current run, awaiting range finalize. */
	pendingCheckpointJobId?: string;
}

/** Resolve the user id. MVP: single local user. */
export function resolveUserId(): string {
	return process.env.BYTE_MENTOR_USER ?? "local";
}

export function createByteMentorContext(cwd: string, sessionId: string): ByteMentorContext {
	const storage = new Storage(defaultLayout());
	return {
		storage,
		checkpointService: new CheckpointService(storage.checkpoints),
		cwd,
		userId: resolveUserId(),
		sessionId,
		checkpointThisRun: false,
	};
}
