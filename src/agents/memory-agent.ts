/**
 * Memory agent orchestrator + checkpoint processor.
 *
 * `processCheckpoint` drives one checkpoint job through the recoverable state
 * machine (design §6.3 / §9):
 *
 *   captured/processing -> run Memory Agent -> commit evidence  => memory_committed
 *   memory_committed     -> apply note patch (idempotent)        => note_applied
 *   note_applied         -> mark done                            => completed
 *
 * Recovery: if evidence is already committed (CommitResult present) we skip the
 * agent's evidence phase and only (re)apply the note patch. The note patch is
 * saved to SQLite BEFORE touching Markdown, so a crash after the file write but
 * before status update re-applies the SAME patch (design §9.3).
 */

import type { Model } from "@earendil-works/pi-ai";
import type { Storage } from "../storage/index.ts";
import type {
	CheckpointJob,
	CommitResult,
	NoteMeta,
	NotePatch,
	TeachingArtifact,
} from "../domain/types.ts";
import { MemoryCommitter } from "../domain/memory-committer.ts";
import { CheckpointService } from "../domain/checkpoint-service.ts";
import { NotePatchApplier } from "../notes/patch-applier.ts";
import { newId, now, slugify } from "../domain/ids.ts";
import { createIsolatedAgent } from "../pi/runtime-factory.ts";
import {
	catalogTools,
	memorySubmitTools,
	stateReadTools,
	type MemorySink,
} from "./agent-tools.ts";
import { MEMORY_SYSTEM_PROMPT } from "./prompts/memory.ts";

export interface ProcessCheckpointDeps {
	storage: Storage;
	agentDir?: string;
	model?: Model<any>;
	signal?: AbortSignal;
	/** Extract the raw teaching transcript for a checkpoint's entry range. */
	getCheckpointTranscript: (job: CheckpointJob) => string;
	/** Human-readable plan summary for context (optional). */
	getPlanSummary?: (planId: string) => string;
}

export interface ProcessResult {
	status: CheckpointJob["status"];
	committed?: CommitResult;
	noteStatus?: "applied" | "conflict" | "skipped";
}

/**
 * Process a single checkpoint job end-to-end. Safe to call repeatedly (recovery).
 */
export async function processCheckpoint(job: CheckpointJob, deps: ProcessCheckpointDeps): Promise<ProcessResult> {
	const { storage } = deps;
	const service = new CheckpointService(storage.checkpoints);
	const committer = new MemoryCommitter(storage);

	if (!job.toEntryId) {
		// range not finalized yet — nothing to do until agent_settled
		return { status: job.status };
	}

	// Take a lease and mark processing (unless already past commit).
	if (job.status === "captured" || job.status === "processing") {
		service.lease(job.id);
	}

	// --- phase 1: evidence commit (skip if already committed) ---------------
	let commitResult = storage.checkpoints.getCommitResult(job.id);
	if (!commitResult) {
		const sink: MemorySink = {};
		const transcript = deps.getCheckpointTranscript(job);
		const planSummary = deps.getPlanSummary?.(job.planId) ?? "";

		const mctx = {
			checkpointId: job.id,
			getCheckpointContext: () =>
				[
					`# Checkpoint 元数据`,
					`moduleTitle: ${job.moduleTitle}`,
					`goalRefs: ${job.goalRefs.join(", ")}`,
					`reason: ${job.reason}`,
					planSummary ? `\n# TeachingPlan\n${planSummary}` : "",
					`\n# 原始教学上下文\n${transcript}`,
				].join("\n"),
			getNoteSection: (unitId: string) => readNoteSection(storage, job.userId, unitId),
		};

		const tools = [
			...catalogTools(storage),
			...stateReadTools(storage, job.userId),
			...memorySubmitTools(sink, mctx),
		];

		const agent = await createIsolatedAgent({
			agentDir: deps.agentDir,
			model: deps.model,
			customTools: tools,
			systemPrompt: MEMORY_SYSTEM_PROMPT,
			signal: deps.signal,
		});

		try {
			await agent.run(
				`处理 checkpoint「${job.moduleTitle}」。先 checkpoint_context_get，再提交 submit_evidence_proposal，最后 submit_note_patch。`,
			);
		} finally {
			agent.dispose();
		}

		if (!sink.proposal) {
			// Agent produced nothing usable; leave as captured for retry.
			storage.checkpoints.setJobStatus(job.id, "captured");
			return { status: "captured" };
		}

		const artifact: TeachingArtifact = {
			checkpointId: job.id,
			sessionId: job.sessionId,
			fromEntryId: job.fromEntryId,
			toEntryId: job.toEntryId,
			moduleTitle: job.moduleTitle,
			goalRefs: job.goalRefs,
			teachingSummary: sink.proposal.artifact.teachingSummary,
			conceptsExplained: sink.proposal.artifact.conceptsExplained,
			examplesUsed: sink.proposal.artifact.examplesUsed,
			exercisesUsed: sink.proposal.artifact.exercisesUsed,
			canonicalTakeaways: sink.proposal.artifact.canonicalTakeaways,
		};

		commitResult = committer.commit({
			checkpointId: job.id,
			artifact,
			items: sink.proposal.items,
		});

		// Stash the agent's note patch (if any) for the note phase below.
		if (sink.notePatch) pendingPatchCache.set(job.id, sink.notePatch);
	}

	const refreshed = storage.checkpoints.getJob(job.id);
	if (refreshed?.status === "needs_review") {
		return { status: "needs_review", committed: commitResult };
	}

	// --- phase 2: note patch (idempotent upsert) ----------------------------
	const noteStatus = applyNotes(storage, deps, job, commitResult);

	// --- phase 3: finalize --------------------------------------------------
	if (noteStatus === "conflict") {
		// keep note_applied? No: leave at note-retryable state for user resolution.
		storage.checkpoints.setJobStatus(job.id, "memory_committed");
		return { status: "memory_committed", committed: commitResult, noteStatus };
	}
	storage.checkpoints.setJobStatus(job.id, "completed");
	return { status: "completed", committed: commitResult, noteStatus };
}

/** In-process cache of the memory agent's proposed note patch, keyed by checkpoint. */
const pendingPatchCache = new Map<string, NotePatch>();

/**
 * Apply notes for a committed checkpoint. Persists a NotePatchJob to SQLite before
 * writing Markdown so retries reuse the same patch text (design §9.3).
 */
function applyNotes(
	storage: Storage,
	deps: ProcessCheckpointDeps,
	job: CheckpointJob,
	commit: CommitResult,
): "applied" | "conflict" | "skipped" {
	const requests = storage.checkpoints.listNoteUpdateRequests(job.id);
	if (requests.length === 0) return "skipped";

	const patch = pendingPatchCache.get(job.id);
	// If no fresh patch (recovery after restart), reuse the last saved patch job.
	const existingJobs = storage.notes.listPatchJobsForCheckpoint(job.id);

	const applier = new NotePatchApplier(storage.layout.notesDir);
	let sawConflict = false;
	let sawApplied = false;

	// Group requests by topic -> one note file per topic.
	// For MVP each knowledge unit maps to its own note keyed by topic node.
	for (const req of requests) {
		const unitId = req.knowledgeUnitId;
		const state = commit.changedStates.find((s) => s.knowledgeNodeId === unitId);
		const version = state?.version ?? req.sourceStateVersion;

		// Determine note metadata (topic + slugged marker unit id).
		const meta = resolveNoteMeta(storage, unitId);
		const markerUnit = meta.markerUnitId;

		// Find or synthesize the patch for this unit.
		let notePatch: NotePatch | undefined = patch;
		if (!notePatch) {
			const saved = existingJobs.find((j) => j.knowledgeUnitId === markerUnit);
			notePatch = saved?.patch;
		}
		if (!notePatch) {
			// No patch content available (agent didn't produce one) — skip note.
			continue;
		}

		// Persist NotePatchJob (idempotent) BEFORE touching disk.
		const jobRow = storage.notes.upsertPatchJob({
			id: newId("np"),
			checkpointId: job.id,
			noteId: meta.note.id,
			knowledgeUnitId: markerUnit,
			sourceStateVersion: version,
			patch: notePatch,
			status: "pending",
			createdAt: now(),
		});

		// Only apply sections relevant to this unit.
		const sections = notePatch.upsertSections.filter((s) => s.knowledgeUnitId === markerUnit);
		if (sections.length === 0) continue;

		const result = applier.apply(meta.note, { ...notePatch, upsertSections: sections }, {});
		if (result.status === "conflict") {
			storage.notes.setPatchJobStatus(jobRow.id, "conflict");
			sawConflict = true;
		} else {
			storage.notes.setPatchJobStatus(jobRow.id, "applied", now());
			storage.notes.upsertNoteMeta(meta.note);
			sawApplied = true;
		}
	}

	pendingPatchCache.delete(job.id);
	if (sawConflict && !sawApplied) return "conflict";
	if (sawConflict) return "conflict";
	return sawApplied ? "applied" : "skipped";
}

/** Resolve (or lazily define) note metadata + a stable marker id for a unit. */
function resolveNoteMeta(
	storage: Storage,
	knowledgeNodeId: string,
): { note: NoteMeta; markerUnitId: string } {
	const node = storage.catalog.getNode(knowledgeNodeId);
	const topicNode = node?.parentId ? storage.catalog.getNode(node.parentId) : node;
	const topicId = topicNode?.id ?? knowledgeNodeId;
	const markerUnitId = slugify(node?.name ?? knowledgeNodeId) || knowledgeNodeId;

	const existing = storage.notes.findNoteForUnit(markerUnitId) ?? storage.notes.findNoteForTopic(topicId);
	if (existing) {
		if (!existing.knowledgeUnitIds.includes(markerUnitId)) {
			existing.knowledgeUnitIds.push(markerUnitId);
		}
		return { note: existing, markerUnitId };
	}

	const topicSlug = slugify(topicNode?.name ?? "topic") || "topic";
	const note: NoteMeta = {
		id: `note-${topicSlug}`,
		topicNodeId: topicId,
		knowledgeUnitIds: [markerUnitId],
		path: `${topicSlug}.md`,
		updatedAt: now(),
	};
	return { note, markerUnitId };
}

/** Read existing controlled note block + metadata for the memory agent. */
function readNoteSection(storage: Storage, userId: string, knowledgeNodeId: string): string {
	const { note, markerUnitId } = resolveNoteMeta(storage, knowledgeNodeId);
	const state = storage.catalog.getState(userId, knowledgeNodeId);
	return [
		`noteId: ${note.id}`,
		`topicNodeId: ${note.topicNodeId}`,
		`knowledgeUnitId(marker): ${markerUnitId}`,
		`notePath: ${note.path}`,
		state ? `\nfinal state:\n${JSON.stringify(state, null, 2)}` : "\n(no existing state)",
	].join("\n");
}
