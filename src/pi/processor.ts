/**
 * Checkpoint processing driver.
 *
 * Wraps the Memory Agent's `processCheckpoint` with the transcript reader and
 * plan summary, and scans for runnable/pending jobs (recovery). Kept separate
 * from hooks.ts so both `agent_settled` and `/learn stop`/session_start recovery
 * can call it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ByteMentorContext } from "./context.ts";

/** Read-only session view as exposed on every extension ctx. */
type ReadonlySessionManager = ExtensionContext["sessionManager"];
import type { CheckpointJob } from "../domain/types.ts";
import { processCheckpoint } from "../agents/memory-agent.ts";
import { readTranscriptRange } from "./transcript.ts";
import { now } from "../domain/ids.ts";

export interface ProcessorEnv {
	ctx: ByteMentorContext;
	sm: ReadonlySessionManager;
	signal?: AbortSignal;
	log?: (message: string) => void;
}

function planSummary(env: ProcessorEnv, planId: string): string {
	const plan = env.ctx.storage.checkpoints.getPlan(planId);
	if (!plan) return "";
	const goals = plan.goals.map((g) => `- ${g.ref}: ${g.candidate.name} — ${g.successCriteria.join("; ")}`).join("\n");
	const prereq = plan.prerequisites
		.map((p) => `- ${p.goalRef}: ${p.userState}/${p.action} — ${p.reason}`)
		.join("\n");
	return `target: ${plan.target.name}\napproach: ${plan.approach}\ngoals:\n${goals}\nprerequisites:\n${prereq}`;
}

/** Process one job to a terminal/awaiting state. */
export async function runJob(job: CheckpointJob, env: ProcessorEnv): Promise<CheckpointJob["status"]> {
	const result = await processCheckpoint(job, {
		storage: env.ctx.storage,
		model: env.ctx.model,
		signal: env.signal,
		getCheckpointTranscript: (j) => readTranscriptRange(env.sm, j.fromEntryId, j.toEntryId ?? j.fromEntryId),
		getPlanSummary: (planId) => planSummary(env, planId),
	});
	env.log?.(`checkpoint ${job.moduleTitle}: ${result.status}${result.noteStatus ? ` (note: ${result.noteStatus})` : ""}`);
	return result.status;
}

/**
 * Process every runnable checkpoint for the current session. Used at
 * agent_settled and during recovery. Sequential to avoid overlapping isolated
 * sessions and DB write contention.
 */
export async function drainRunnableCheckpoints(env: ProcessorEnv): Promise<number> {
	const jobs = env.ctx.storage.checkpoints.listRunnableJobs(env.ctx.sessionId, now());
	let processed = 0;
	for (const job of jobs) {
		try {
			await runJob(job, env);
			processed++;
		} catch (err) {
			env.log?.(`checkpoint ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return processed;
}
