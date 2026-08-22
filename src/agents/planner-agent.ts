/**
 * Planner agent orchestrator.
 *
 * Runs an isolated, read-only agent that compiles long-term memory into a
 * TeachingPlan for one lesson run. Output is captured via `submit_teaching_plan`
 * (PlannerSink), never parsed from free text. The Planner cannot write memory.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { Storage } from "../storage/index.ts";
import type { TeachingPlan } from "../domain/types.ts";
import { newId, now } from "../domain/ids.ts";
import { createIsolatedAgent } from "../pi/runtime-factory.ts";
import { catalogTools, plannerSubmitTool, stateReadTools, type PlannerSink } from "./agent-tools.ts";
import { PLANNER_SYSTEM_PROMPT } from "./prompts/planner.ts";

export interface RunPlannerInput {
	storage: Storage;
	userId: string;
	lessonRunId: string;
	target: string;
	agentDir?: string;
	model?: Model<any>;
	signal?: AbortSignal;
}

/**
 * Run the Planner and persist its plan. Returns the saved TeachingPlan, or
 * undefined if the agent failed to produce one.
 */
export async function runPlanner(input: RunPlannerInput): Promise<TeachingPlan | undefined> {
	const sink: PlannerSink = {};
	const tools = [
		...catalogTools(input.storage),
		...stateReadTools(input.storage, input.userId),
		plannerSubmitTool(sink),
	];

	const agent = await createIsolatedAgent({
		agentDir: input.agentDir,
		model: input.model,
		customTools: tools,
		systemPrompt: PLANNER_SYSTEM_PROMPT,
		signal: input.signal,
	});

	try {
		await agent.run(
			`学习目标：${input.target}\n\n请规划本轮教学。先渐进检索知识树与用户状态，再调用 submit_teaching_plan 提交计划。`,
		);
	} finally {
		agent.dispose();
	}

	if (!sink.plan) return undefined;

	const plan: TeachingPlan = {
		id: newId("plan"),
		lessonRunId: input.lessonRunId,
		target: sink.plan.target,
		goals: sink.plan.goals,
		prerequisites: sink.plan.prerequisites,
		approach: sink.plan.approach,
		createdAt: now(),
	};

	input.storage.checkpoints.insertPlan(plan);
	input.storage.checkpoints.setLessonPlan(input.lessonRunId, plan.id);
	return plan;
}
