/**
 * Byte Mentor — Pi extension entry point.
 *
 * This factory is the REGISTRATION phase only (two-phase init, DEVELOPMENT.md):
 * it registers the Actor tool, the /learn command, and event hooks. No action
 * methods (sendMessage/setModel/etc.) and no background resources are started
 * here — storage opens at session_start, and isolated agents run inside hooks
 * and the command handler.
 *
 * See:
 *   - pi-mvp-design.md   (runtime architecture, reliability boundaries)
 *   - memory-requirements.md (learning-memory domain model)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ByteMentorContext } from "./pi/context.ts";
import { createLearningCheckpointTool } from "./pi/actor-tools.ts";
import { registerCommands } from "./pi/commands.ts";
import { registerHooks } from "./pi/hooks.ts";

export default function byteMentorExtension(pi: ExtensionAPI): void {
	// Shared, mutable runtime state. Populated at session_start (never here).
	const state: { ctx?: ByteMentorContext } = {};

	// Actor's only write capability.
	pi.registerTool(createLearningCheckpointTool(() => state.ctx));

	// /learn <goal> | stop | status
	registerCommands(pi, state);

	// session_start / before_agent_start / context / tool_call / agent_settled /
	// session_shutdown / resources_discover
	registerHooks(pi, state);
}
