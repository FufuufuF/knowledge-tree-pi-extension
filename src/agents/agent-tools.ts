/**
 * Custom tools exposed to the isolated Planner / Memory agents.
 *
 * Two families:
 *   - read-only catalog/state/evidence browsing (progressive, per design §5.3),
 *   - "submit" tools that capture the agent's structured output out-of-band via a
 *     sink callback (so we never parse free-form final text).
 *
 * None of these can write formal memory directly. `submit_evidence_proposal`
 * hands a proposal to the Memory Committer; `submit_note_patch` hands a patch to
 * the Note Patch Applier.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Storage } from "../storage/index.ts";
import type {
	EvidenceProposal,
	EvidenceProposalItem,
	NotePatch,
	TeachingArtifact,
	TeachingPlan,
} from "../domain/types.ts";

type Text = { type: "text"; text: string };
function text(s: string): { content: Text[]; details: unknown } {
	return { content: [{ type: "text", text: s }], details: undefined };
}

// ============================================================================
// Schemas
// ============================================================================

const CatalogListChildrenSchema = Type.Object({
	parentId: Type.Optional(Type.String({ description: "Parent node id; omit for roots." })),
});
const CatalogSearchSchema = Type.Object({
	query: Type.String({ description: "Search text." }),
	parentId: Type.Optional(Type.String()),
});
const CatalogGetNodeSchema = Type.Object({ nodeId: Type.String() });

const LearningStateGetSchema = Type.Object({ knowledgeNodeId: Type.String() });
const LearningEvidenceGetSchema = Type.Object({ knowledgeNodeId: Type.String() });

const CANDIDATE_SCHEMA = Type.Object({
	name: Type.String(),
	definition: Type.String(),
	learningGoals: Type.Optional(Type.Array(Type.String())),
	suggestedParentPath: Type.Optional(Type.Array(Type.String())),
});

const SubmitTeachingPlanSchema = Type.Object({
	target: CANDIDATE_SCHEMA,
	goals: Type.Array(
		Type.Object({
			ref: Type.String({ description: "Stable short id, e.g. 'g1'." }),
			candidate: CANDIDATE_SCHEMA,
			matchedNodeId: Type.Optional(Type.String()),
			successCriteria: Type.Array(Type.String()),
		}),
	),
	prerequisites: Type.Array(
		Type.Object({
			goalRef: Type.String(),
			userState: Type.Union([Type.Literal("known"), Type.Literal("weak"), Type.Literal("unknown")]),
			action: Type.Union([
				Type.Literal("use"),
				Type.Literal("diagnose"),
				Type.Literal("offer_remediation"),
			]),
			reason: Type.String(),
		}),
	),
	approach: Type.String({ description: "Free-text teaching approach for the Actor." }),
});

const PROPOSAL_ITEM_SCHEMA = Type.Object({
	goalRef: Type.String(),
	candidate: CANDIDATE_SCHEMA,
	matchedNodeId: Type.Optional(Type.String()),
	source: Type.Union([
		Type.Literal("prior_knowledge"),
		Type.Literal("learning_outcome"),
		Type.Literal("self_report"),
		Type.Literal("delayed_recall"),
	]),
	summary: Type.String(),
	result: Type.Union([
		Type.Literal("correct"),
		Type.Literal("partially_correct"),
		Type.Literal("incorrect"),
		Type.Literal("unclear"),
	]),
	prompted: Type.Boolean(),
	confidence: Type.Number(),
	turnId: Type.String(),
	proposedMastery: Type.Union([
		Type.Literal("unknown"),
		Type.Literal("missing"),
		Type.Literal("partial"),
		Type.Literal("unstable"),
		Type.Literal("stable"),
	]),
	misconception: Type.Optional(Type.String()),
	resolvesMisconception: Type.Optional(Type.Boolean()),
});

const ARTIFACT_SCHEMA = Type.Object({
	teachingSummary: Type.String(),
	conceptsExplained: Type.Array(Type.String()),
	examplesUsed: Type.Array(Type.String()),
	exercisesUsed: Type.Array(Type.String()),
	canonicalTakeaways: Type.Array(Type.String()),
});

const CheckpointContextGetSchema = Type.Object({});
const NoteSectionGetSchema = Type.Object({ knowledgeUnitId: Type.String() });
const SubmitEvidenceProposalSchema = Type.Object({
	artifact: ARTIFACT_SCHEMA,
	items: Type.Array(PROPOSAL_ITEM_SCHEMA),
});
const SubmitNotePatchSchema = Type.Object({
	noteId: Type.String(),
	topicNodeId: Type.String(),
	upsertSections: Type.Array(
		Type.Object({
			knowledgeUnitId: Type.String(),
			title: Type.String(),
			markdown: Type.String({
				description: "Body markdown (sections like 核心理解 / 我的易错点 / 自测). No H1/frontmatter.",
			}),
		}),
	),
});

// ============================================================================
// Read-only catalog tools (shared by Planner + Memory)
// ============================================================================

export function catalogTools(storage: Storage): ToolDefinition[] {
	const catalogListChildrenTool: ToolDefinition<typeof CatalogListChildrenSchema> = {
		name: "catalog_listChildren",
		label: "List catalog children",
		description:
			"List direct child knowledge nodes of a parent node. Omit parentId to list root topics. Use this to browse the knowledge tree top-down.",
		parameters: CatalogListChildrenSchema,
		async execute(_id, params) {
			const nodes = storage.catalog.listChildren(params.parentId);
			return text(JSON.stringify(nodes, null, 2));
		},
	};
	const catalogSearchTool: ToolDefinition<typeof CatalogSearchSchema> = {
		name: "catalog_search",
		label: "Search catalog",
		description:
			"Keyword-search knowledge nodes by name (normalized). Optionally scope to a parent node. Returns up to 25 matches.",
		parameters: CatalogSearchSchema,
		async execute(_id, params) {
			const nodes = storage.catalog.search(params.query, params.parentId);
			return text(JSON.stringify(nodes, null, 2));
		},
	};
	const catalogGetNodeTool: ToolDefinition<typeof CatalogGetNodeSchema> = {
		name: "catalog_getNode",
		label: "Get catalog node",
		description: "Fetch a single knowledge node by id.",
		parameters: CatalogGetNodeSchema,
		async execute(_id, params) {
			const node = storage.catalog.getNode(params.nodeId);
			return text(node ? JSON.stringify(node, null, 2) : "null");
		},
	};
	return [catalogListChildrenTool, catalogSearchTool, catalogGetNodeTool];
}

// ============================================================================
// State / evidence read tools (shared)
// ============================================================================

export function stateReadTools(storage: Storage, userId: string): ToolDefinition[] {
	const learningStateGetTool: ToolDefinition<typeof LearningStateGetSchema> = {
		name: "learning_state_get",
		label: "Get user knowledge state",
		description:
			"Read the current UserKnowledgeState (exposure, mastery, misconceptions) for a knowledge node, for the active user. Returns null if none.",
		parameters: LearningStateGetSchema,
		async execute(_id, params) {
			const state = storage.catalog.getState(userId, params.knowledgeNodeId);
			return text(state ? JSON.stringify(state, null, 2) : "null");
		},
	};
	const learningEvidenceGetTool: ToolDefinition<typeof LearningEvidenceGetSchema> = {
		name: "learning_evidence_get",
		label: "Get learning evidence",
		description: "List append-only LearningEvidence for a knowledge node and the active user, chronological.",
		parameters: LearningEvidenceGetSchema,
		async execute(_id, params) {
			const ev = storage.catalog.listEvidence(userId, params.knowledgeNodeId);
			return text(JSON.stringify(ev, null, 2));
		},
	};
	return [learningStateGetTool, learningEvidenceGetTool];
}

// ============================================================================
// Planner submit tool
// ============================================================================

export interface PlannerSink {
	plan?: Omit<TeachingPlan, "id" | "lessonRunId" | "createdAt">;
}

export function plannerSubmitTool(sink: PlannerSink): ToolDefinition {
	const submitTeachingPlanTool: ToolDefinition<typeof SubmitTeachingPlanSchema> = {
		name: "submit_teaching_plan",
		label: "Submit teaching plan",
		description:
			"Submit the compiled TeachingPlan for this lesson. Call exactly once when planning is complete. goals[].ref are stable references the Actor uses to organize teaching freely. Do not create nodes or states.",
		parameters: SubmitTeachingPlanSchema,
		async execute(_id, params) {
			sink.plan = {
				target: params.target,
				goals: params.goals,
				prerequisites: params.prerequisites,
				approach: params.approach,
			};
			return { ...text("Teaching plan recorded."), terminate: true };
		},
	};
	return submitTeachingPlanTool;
}

// ============================================================================
// Memory agent submit tools
// ============================================================================

export interface MemorySink {
	proposal?: {
		artifact: Pick<
			TeachingArtifact,
			"teachingSummary" | "conceptsExplained" | "examplesUsed" | "exercisesUsed" | "canonicalTakeaways"
		>;
		items: EvidenceProposalItem[];
	};
	notePatch?: NotePatch;
}

/**
 * Memory agent tools that mutate state, provided as a factory so they can close
 * over the current checkpoint context (checkpointId, raw context accessor, and
 * the deterministic commit/apply callbacks supplied by the pipeline).
 */
export interface MemoryToolContext {
	checkpointId: string;
	/** Returns the raw checkpoint transcript + plan + metadata as text. */
	getCheckpointContext: () => string;
	/** Returns the last committed state + note block for a knowledge unit. */
	getNoteSection: (knowledgeUnitId: string) => string;
}

export function memorySubmitTools(sink: MemorySink, mctx: MemoryToolContext): ToolDefinition[] {
	const checkpointContextGetTool: ToolDefinition<typeof CheckpointContextGetSchema> = {
		name: "checkpoint_context_get",
		label: "Get checkpoint context",
		description:
			"Read this checkpoint's raw teaching transcript, TeachingPlan, and metadata (module, goalRefs). Call first to understand what was actually taught.",
		parameters: CheckpointContextGetSchema,
		async execute() {
			return text(mctx.getCheckpointContext());
		},
	};
	const noteSectionGetTool: ToolDefinition<typeof NoteSectionGetSchema> = {
		name: "note_section_get",
		label: "Get existing note section",
		description:
			"Read the existing controlled Markdown block and file metadata for a knowledge unit, so a patch preserves prior review content.",
		parameters: NoteSectionGetSchema,
		async execute(_id, params) {
			return text(mctx.getNoteSection(params.knowledgeUnitId));
		},
	};
	const submitEvidenceProposalTool: ToolDefinition<typeof SubmitEvidenceProposalSchema> = {
		name: "submit_evidence_proposal",
		label: "Submit evidence proposal",
		description:
			"Submit structured evidence + a teaching artifact for this checkpoint. The Committer aligns nodes and conservatively reduces state — you cannot set mastery to 'stable' directly. Call once, before writing notes.",
		parameters: SubmitEvidenceProposalSchema,
		async execute(_id, params) {
			sink.proposal = {
				artifact: params.artifact,
				items: params.items as EvidenceProposalItem[],
			};
			return text("Evidence proposal recorded. Now read final state and submit a note patch.");
		},
	};
	const submitNotePatchTool: ToolDefinition<typeof SubmitNotePatchSchema> = {
		name: "submit_note_patch",
		label: "Submit note patch",
		description:
			"Submit a structured Markdown patch for one topic's knowledge units. Only include units the Committer confirmed. Content is upserted between controlled markers; never rewrite whole files.",
		parameters: SubmitNotePatchSchema,
		async execute(_id, params) {
			sink.notePatch = {
				noteId: params.noteId,
				topicNodeId: params.topicNodeId,
				upsertSections: params.upsertSections,
			};
			return { ...text("Note patch recorded."), terminate: true };
		},
	};
	return [checkpointContextGetTool, noteSectionGetTool, submitEvidenceProposalTool, submitNotePatchTool];
}

/** Serialize an EvidenceProposal for the committer from the memory sink. */
export function buildProposal(
	checkpointId: string,
	artifact: TeachingArtifact,
	items: EvidenceProposalItem[],
): EvidenceProposal {
	return { checkpointId, artifact, items };
}
