/**
 * Runtime factory for isolated Planner / Memory agent sessions (design §4.1).
 *
 * Each isolated agent runs in a fresh in-process Pi AgentSession that:
 *   - uses an in-memory SessionManager (never touches the user's session files),
 *   - runs in a temporary cwd so project-local resources (`.pi/extensions`,
 *     skills, context files) are NOT discovered — Byte Mentor never re-loads
 *     itself recursively,
 *   - still loads global packages (e.g. the codemax provider plugin), so model
 *     providers registered there are available to the sub-agent,
 *   - exposes ONLY an explicit custom-tool whitelist (no built-in file/shell tools).
 *
 * The agent is driven by a single `prompt()` call. Structured output is captured
 * out-of-band by a "submit" tool the agent must call (see planner/memory agents),
 * not by parsing the final assistant text.
 */

import * as os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface IsolatedAgentOptions {
	agentDir?: string;
	model?: Model<any>;
	/** Custom tools this agent may use. Built-in tools are all disabled. */
	customTools: ToolDefinition[];
	/** System prompt appended for the specialized role. */
	systemPrompt: string;
	signal?: AbortSignal;
}

export interface IsolatedAgentRun {
	/** Run the agent to completion on `task`. Resolves when the agent settles. */
	run(task: string): Promise<void>;
	dispose(): void;
}

/**
 * Build (but do not start) an isolated agent session with a locked-down toolset.
 */
export async function createIsolatedAgent(options: IsolatedAgentOptions): Promise<IsolatedAgentRun> {
	const agentDir = options.agentDir ?? getAgentDir();

	// Temporary cwd: project-local auto-discovery (.pi/extensions, skills,
	// context files) is cwd-relative, so running in a scratch dir means Byte
	// Mentor (this extension) is never loaded recursively. Global packages
	// from settings (e.g. the codemax provider) still load, so the model
	// passed in stays usable inside the sub-agent.
	const isoCwd = await mkdtemp(join(os.tmpdir(), "pi-byte-mentor-"));
	const settingsManager = SettingsManager.create(isoCwd, agentDir);

	const resourceLoader = new DefaultResourceLoader({
		cwd: isoCwd,
		agentDir,
		settingsManager,
		// Global packages only; project extensions are excluded by isoCwd.
		noExtensions: false,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		systemPrompt: options.systemPrompt,
	});
	await resourceLoader.reload();

	const toolNames = options.customTools.map((t) => t.name);

	const { session } = await createAgentSession({
		cwd: isoCwd,
		model: options.model,
		sessionManager: SessionManager.inMemory(isoCwd),
		resourceLoader,
		customTools: options.customTools,
		// Explicit whitelist => only the role's tools are active.
		tools: toolNames,
		// Belt-and-suspenders: suppress default built-ins.
		noTools: "builtin",
	});

	return {
		async run(task: string): Promise<void> {
			// expandPromptTemplates:false so a leading "/" in a task is never treated
			// as a command; source "extension" marks it as programmatic input.
			await session.prompt(task, {
				expandPromptTemplates: false,
				source: "extension",
			} as Parameters<typeof session.prompt>[1]);
		},
		dispose(): void {
			try {
				session.dispose();
			} catch {
				// best-effort
			}
			void rm(isoCwd, { recursive: true, force: true }).catch(() => {});
		},
	};
}
