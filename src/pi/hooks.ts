/**
 * Pi event hooks (design §4.2).
 *
 *   session_start        open storage, restore active lesson + recover jobs
 *   before_agent_start   inject active plan + Actor teaching rules; reset per-run flag
 *   context              re-inject plan + pending-module summary after compaction
 *   tool_call            validate learning_checkpoint (lesson/plan/goal refs; one/run)
 *   agent_settled        finalize checkpoint range, run Memory Agent
 *   session_shutdown     persist; leave unfinished work for next recovery
 *   resources_discover   publish the Byte Mentor skill
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ByteMentorContext } from "./context.ts";
import { createByteMentorContext } from "./context.ts";
import { drainRunnableCheckpoints } from "./processor.ts";
import { lastAssistantEntryId } from "./transcript.ts";
import type { TeachingPlan } from "../domain/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(HERE, "..", "resources", "skills");

type CheckpointToolInput = {
	moduleTitle: string;
	goalRefs: string[];
	reason: string;
};

/** Compact, model-facing rendering of the active plan for injection. */
function renderPlanForActor(plan: TeachingPlan): string {
	const goals = plan.goals
		.map((g) => `- ${g.ref}: ${g.candidate.name}\n    成功标准: ${g.successCriteria.join("; ")}`)
		.join("\n");
	const prereq = plan.prerequisites
		.map((p) => `- ${p.goalRef}: 用户状态=${p.userState}, 动作=${p.action} (${p.reason})`)
		.join("\n");
	return [
		"# Byte Mentor 教学计划（隐藏，勿直接复述）",
		`目标: ${plan.target.name}`,
		`教学方式: ${plan.approach}`,
		"教学目标:",
		goals || "(无)",
		"前置知识处理:",
		prereq || "(无)",
		"",
		"# Actor 教学规则",
		"- 按计划自由教学，可自行选择解释方式、案例、追问时机。",
		"- 不重复讲解用户已掌握（known/use）的前置内容；对 diagnose 的点先用低成本问题诊断。",
		"- 在一个知识单元的讲解+练习+反馈形成完整模块后，调用 learning_checkpoint（每轮最多一次）。",
		"- 刚做完一次解释、用户尚无新表现时，不要 checkpoint。",
	].join("\n");
}

export function registerHooks(pi: ExtensionAPI, state: { ctx?: ByteMentorContext }): void {
	// ---- session_start: open storage, restore, recover ----------------------
	pi.on("session_start", async (_event, extCtx) => {
		const sessionId = extCtx.sessionManager.getSessionId();
		const ctx = createByteMentorContext(extCtx.cwd, sessionId);
		state.ctx = ctx;
		ctx.model = extCtx.model;

		// Restore active lesson run + plan.
		const run = ctx.storage.checkpoints.getActiveLessonRun(sessionId);
		if (run) {
			ctx.activeLessonRunId = run.id;
			if (run.planId) ctx.activePlan = ctx.storage.checkpoints.getPlan(run.planId);
		}

		// Recover non-terminal checkpoint jobs (best-effort, background).
		void drainRunnableCheckpoints({
			ctx,
			sm: extCtx.sessionManager,
			signal: extCtx.signal,
			log: (m) => extCtx.ui.notify(`Byte Mentor: ${m}`, "info"),
		}).catch(() => {});
	});

	// ---- before_agent_start: inject plan + reset per-run flag ---------------
	pi.on("before_agent_start", async (_event, extCtx) => {
		const ctx = state.ctx;
		if (!ctx) return;
		ctx.checkpointThisRun = false;
		ctx.pendingCheckpointJobId = undefined;
		ctx.model = extCtx.model ?? ctx.model;

		if (!ctx.activePlan) return;
		return {
			message: {
				customType: "byte-mentor:plan",
				content: [{ type: "text", text: renderPlanForActor(ctx.activePlan) }],
				display: false,
			},
		};
	});

	// ---- context: re-inject plan after compaction --------------------------
	pi.on("context", async (event) => {
		const ctx = state.ctx;
		if (!ctx?.activePlan) return;
		// Only re-inject if the plan text isn't already present in the tail.
		const hasPlan = event.messages.some(
			(m) =>
				Array.isArray((m as { content?: unknown }).content) &&
				JSON.stringify((m as { content: unknown }).content).includes("Byte Mentor 教学计划"),
		);
		if (hasPlan) return;

		const pending = ctx.storage.checkpoints.listPendingJobs(ctx.sessionId);
		const pendingText = pending.length
			? `\n# 待处理模块\n${pending.map((j) => `- ${j.moduleTitle} (${j.status})`).join("\n")}`
			: "";
		const messages = [...event.messages];
		messages.push({
			role: "user",
			content: [{ type: "text", text: renderPlanForActor(ctx.activePlan) + pendingText }],
			timestamp: Date.now(),
		} as (typeof event.messages)[number]);
		return { messages };
	});

	// ---- tool_call: validate learning_checkpoint ---------------------------
	pi.on("tool_call", async (event) => {
		const ctx = state.ctx;
		if (!isToolCallEventType<"learning_checkpoint", CheckpointToolInput>("learning_checkpoint", event)) return;
		if (!ctx) return { block: true, reason: "Byte Mentor not initialized." };
		if (!ctx.activeLessonRunId || !ctx.activePlan) {
			return { block: true, reason: "No active lesson. Use /learn <goal> first." };
		}
		if (ctx.checkpointThisRun) {
			return { block: true, reason: "Only one checkpoint per run is allowed." };
		}
		// Validate goalRefs are known to the plan.
		const known = new Set(ctx.activePlan.goals.map((g) => g.ref));
		const refs = event.input.goalRefs ?? [];
		const unknown = refs.filter((r) => !known.has(r));
		if (unknown.length > 0) {
			return { block: true, reason: `Unknown goalRefs: ${unknown.join(", ")}` };
		}
		return;
	});

	// ---- agent_settled: finalize range + process ---------------------------
	pi.on("agent_settled", async (_event, extCtx) => {
		const ctx = state.ctx;
		if (!ctx) return;

		// Finalize the pending checkpoint's toEntryId to the run's last assistant.
		if (ctx.pendingCheckpointJobId) {
			const toId = lastAssistantEntryId(extCtx.sessionManager);
			if (toId) ctx.checkpointService.finalizeRange(ctx.pendingCheckpointJobId, toId);
			ctx.pendingCheckpointJobId = undefined;
		}

		await drainRunnableCheckpoints({
			ctx,
			sm: extCtx.sessionManager,
			signal: extCtx.signal,
			log: (m) => extCtx.ui.notify(`Byte Mentor: ${m}`, "info"),
		});
	});

	// ---- session_shutdown: persist, close ----------------------------------
	pi.on("session_shutdown", async () => {
		const ctx = state.ctx;
		if (!ctx) return;
		// Do not block shutdown on async processing; unfinished jobs are recovered.
		ctx.storage.close();
		state.ctx = undefined;
	});

	// ---- resources_discover: publish Byte Mentor skill ---------------------
	pi.on("resources_discover", async () => {
		return { skillPaths: [SKILL_DIR] };
	});
}

// keep ExtensionContext import used (type only) for editor clarity
export type { ExtensionContext };
