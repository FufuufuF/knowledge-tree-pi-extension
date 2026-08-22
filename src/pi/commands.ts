/**
 * `/learn` command family (design §4.2).
 *
 *   /learn <goal>   create a lesson run, invoke the Planner, start Actor mode
 *   /learn stop     end the lesson run and drain pending checkpoint / note jobs
 *   /learn status   show active plan, pending checkpoints, dirty note count
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ByteMentorContext } from "./context.ts";
import { drainRunnableCheckpoints } from "./processor.ts";
import { runPlanner } from "../agents/planner-agent.ts";
import type { LessonRun } from "../domain/types.ts";
import { newId, now } from "../domain/ids.ts";

export function registerCommands(pi: ExtensionAPI, state: { ctx?: ByteMentorContext }): void {
	pi.registerCommand("learn", {
		description: "Start/stop a Byte Mentor learning session: /learn <goal> | /learn stop | /learn status",
		getArgumentCompletions: (prefix) => {
			const subs = ["stop", "status"];
			const filtered = subs.filter((s) => s.startsWith(prefix.trim()));
			return filtered.length ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, extCtx) => {
			const ctx = state.ctx;
			if (!ctx) {
				extCtx.ui.notify("Byte Mentor is not initialized yet.", "error");
				return;
			}
			const arg = args.trim();

			if (arg === "status") {
				return showStatus(ctx, extCtx);
			}
			if (arg === "stop") {
				return stopLesson(ctx, extCtx);
			}
			if (!arg) {
				extCtx.ui.notify("Usage: /learn <goal> | /learn stop | /learn status", "warning");
				return;
			}

			await startLesson(pi, ctx, extCtx, arg);
		},
	});
}

async function startLesson(
	pi: ExtensionAPI,
	ctx: ByteMentorContext,
	extCtx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
	target: string,
): Promise<void> {
	// End any prior active run for this session.
	const prior = ctx.storage.checkpoints.getActiveLessonRun(ctx.sessionId);
	if (prior) ctx.storage.checkpoints.setLessonStatus(prior.id, "stopped");

	const run: LessonRun = {
		id: newId("run"),
		userId: ctx.userId,
		sessionId: ctx.sessionId,
		target,
		status: "active",
		createdAt: now(),
		updatedAt: now(),
	};
	ctx.storage.checkpoints.insertLessonRun(run);
	ctx.activeLessonRunId = run.id;
	ctx.activePlan = undefined;
	ctx.model = extCtx.model ?? ctx.model;

	extCtx.ui.notify(`Byte Mentor: planning "${target}"…`, "info");

	let plan;
	try {
		plan = await runPlanner({
			storage: ctx.storage,
			userId: ctx.userId,
			lessonRunId: run.id,
			target,
			model: ctx.model,
			signal: extCtx.signal,
		});
	} catch (err) {
		extCtx.ui.notify(`Planner failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}

	if (!plan) {
		extCtx.ui.notify("Planner produced no plan. Teaching without a compiled plan.", "warning");
		return;
	}

	ctx.activePlan = plan;
	extCtx.ui.notify(
		`Byte Mentor: plan ready (${plan.goals.length} goals). Start teaching — I'll track your progress.`,
		"info",
	);

	// Kick off the Actor: send a user-visible instruction to begin.
	pi.sendUserMessage(
		`我们开始学习「${target}」。请你作为导师按计划教学，并在合适的时候检查我的理解。`,
	);
}

async function stopLesson(
	ctx: ByteMentorContext,
	extCtx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
): Promise<void> {
	if (!ctx.activeLessonRunId) {
		extCtx.ui.notify("No active lesson.", "info");
		return;
	}
	extCtx.ui.notify("Byte Mentor: finishing pending work…", "info");

	const processed = await drainRunnableCheckpoints({
		ctx,
		sm: extCtx.sessionManager,
		signal: extCtx.signal,
		log: (m) => extCtx.ui.notify(`Byte Mentor: ${m}`, "info"),
	});

	ctx.storage.checkpoints.setLessonStatus(ctx.activeLessonRunId, "stopped");
	ctx.activeLessonRunId = undefined;
	ctx.activePlan = undefined;
	extCtx.ui.notify(`Byte Mentor: lesson stopped. Processed ${processed} checkpoint(s).`, "info");
}

function showStatus(
	ctx: ByteMentorContext,
	extCtx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
): void {
	const pending = ctx.storage.checkpoints.listPendingJobs(ctx.sessionId);
	const dirty = ctx.storage.notes.countDirtyNotes();
	const lines: string[] = [];
	lines.push(ctx.activePlan ? `Active plan: ${ctx.activePlan.target.name} (${ctx.activePlan.goals.length} goals)` : "No active plan.");
	lines.push(`Pending checkpoints: ${pending.length}`);
	for (const j of pending) lines.push(`  - ${j.moduleTitle} [${j.status}]`);
	lines.push(`Dirty notes: ${dirty}`);
	extCtx.ui.notify(lines.join("\n"), "info");
}
