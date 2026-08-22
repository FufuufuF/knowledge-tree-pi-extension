/**
 * Actor-facing tool: `learning_checkpoint`.
 *
 * The Actor's only write capability. It does NOT receive transcripts, evidence,
 * mastery, misconceptions, node ids, or Markdown — only a module title, goalRefs,
 * and a reason (design §4.2). It creates a durable captured CheckpointJob; the
 * range is finalized later at agent_settled and processed by the Memory Agent.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ByteMentorContext } from "./context.ts";
import { currentLeafEntryId } from "./transcript.ts";

const LearningCheckpointSchema = Type.Object({
	moduleTitle: Type.String({ description: "Short title of the module just completed." }),
	goalRefs: Type.Array(Type.String(), {
		description: "The plan goal refs (e.g. g1, g2) this module covered.",
	}),
	reason: Type.String({ description: "Why this is a checkpoint boundary." }),
});

export function createLearningCheckpointTool(getCtx: () => ByteMentorContext | undefined): ToolDefinition {
	const learningCheckpointTool: ToolDefinition<typeof LearningCheckpointSchema> = {
		name: "learning_checkpoint",
		label: "Learning checkpoint",
		description:
			"Mark that a coherent teaching module just finished (explanation + practice + feedback), so the tutor's long-term memory can be updated. Call at most once per turn, only when a real module boundary is reached — not after a single explanation with no new user performance.",
		promptSnippet: "Record a completed teaching module for long-term memory.",
		promptGuidelines: [
			"Call learning_checkpoint only at a genuine module boundary: a knowledge unit's explanation + practice + feedback are complete, a diagnostic/exercise set finished, or you are about to switch topics, pause, or end.",
			"Do not checkpoint right after a single explanation when the user has not yet demonstrated anything.",
			"You never pass transcripts, scores, or notes — only moduleTitle, goalRefs, and a short reason.",
		],
		parameters: LearningCheckpointSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, extCtx) {
			const ctx = getCtx();
			if (!ctx) {
				throw new Error("Byte Mentor is not initialized in this session.");
			}
			if (!ctx.activeLessonRunId || !ctx.activePlan) {
				throw new Error("No active lesson. Start one with /learn <goal> before checkpointing.");
			}
			if (ctx.checkpointThisRun) {
				throw new Error("A checkpoint was already created this turn. Only one checkpoint per run is allowed.");
			}

			const fromEntryId = currentLeafEntryId(extCtx.sessionManager) ?? "start";

			const job = ctx.checkpointService.capture({
				userId: ctx.userId,
				sessionId: ctx.sessionId,
				lessonRunId: ctx.activeLessonRunId,
				planId: ctx.activePlan.id,
				moduleTitle: params.moduleTitle,
				goalRefs: params.goalRefs,
				reason: params.reason,
				fromEntryId,
			});

			ctx.checkpointThisRun = true;
			ctx.pendingCheckpointJobId = job.id;

			return {
				content: [
					{
						type: "text",
						text: `Checkpoint captured for "${params.moduleTitle}". It will be processed after this turn settles.`,
					},
				],
				details: { checkpointId: job.id, status: job.status },
			};
		},
	};
	return learningCheckpointTool;
}
