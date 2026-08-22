/**
 * Read the raw teaching transcript for a checkpoint's entry range from a Pi
 * session branch. The extension reads this from the session itself — the Actor
 * never copies or passes message lists (design §6.2).
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Read-only session view as exposed on every extension ctx. */
type ReadonlySessionManager = ExtensionContext["sessionManager"];

/** Flatten a message's content into plain text for the Memory Agent. */
function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => {
				if (c && typeof c === "object" && "type" in c) {
					const part = c as { type: string; text?: string };
					if (part.type === "text" && part.text) return part.text;
					if (part.type === "toolResult") return "[tool result]";
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function entryRole(entry: SessionEntry): string {
	if (entry.type === "message") {
		return (entry.message as { role?: string }).role ?? "message";
	}
	return entry.type;
}

/**
 * Return the transcript between `fromEntryId` and `toEntryId` (inclusive) as a
 * role-tagged text block. Falls back to the whole branch if ids are not found.
 */
export function readTranscriptRange(
	sm: ReadonlySessionManager,
	fromEntryId: string,
	toEntryId: string,
): string {
	const branch = sm.getBranch();
	const fromIdx = branch.findIndex((e) => e.id === fromEntryId);
	const toIdx = branch.findIndex((e) => e.id === toEntryId);

	const start = fromIdx === -1 ? 0 : fromIdx;
	const end = toIdx === -1 ? branch.length - 1 : toIdx;
	const slice = branch.slice(start, end + 1);

	const lines: string[] = [];
	for (const entry of slice) {
		if (entry.type !== "message") continue;
		const role = entryRole(entry);
		if (role !== "user" && role !== "assistant") continue;
		const txt = messageText(entry.message).trim();
		if (!txt) continue;
		lines.push(`## ${role}\n${txt}`);
	}
	return lines.join("\n\n") || "(empty transcript)";
}

/** Id of the last assistant message entry in the current branch, if any. */
export function lastAssistantEntryId(sm: ReadonlySessionManager): string | undefined {
	const branch = sm.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry && entry.type === "message" && (entry.message as { role?: string }).role === "assistant") {
			return entry.id;
		}
	}
	return undefined;
}

/** Id of the most recent entry in the branch (used as a checkpoint's fromEntryId). */
export function currentLeafEntryId(sm: ReadonlySessionManager): string | undefined {
	const leaf = sm.getLeafEntry();
	return leaf?.id ?? sm.getLeafId() ?? undefined;
}
