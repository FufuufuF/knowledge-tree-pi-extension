/**
 * Byte Mentor domain types.
 *
 * These are the canonical shapes for the learning-memory model. They merge the
 * long-term memory model from `memory-requirements.md` (KnowledgeNode,
 * UserKnowledgeState, LearningEvidence) with the MVP runtime entities from
 * `pi-mvp-design.md` (TeachingPlan, CheckpointJob, TeachingArtifact, NotePatchJob,
 * CommitResult).
 *
 * Nothing here talks to SQLite or Pi — this module is pure data.
 */

// ============================================================================
// Knowledge tree
// ============================================================================

/** ISO-8601 timestamp string. */
export type IsoTime = string;

/**
 * A node in the lazily-grown knowledge tree. The tree is a teaching-memory
 * catalogue, not a complete ontology: nodes only exist once a user has actually
 * studied, been assessed on, or exposed a misconception about the concept.
 */
export interface KnowledgeNode {
	id: string;
	parentId?: string;

	name: string;
	/** Stable boundary/definition used for node alignment, not a full lecture. */
	definition: string;
	learningGoals?: string[];

	/** Whether this node can itself be taught/assessed. Independent of having children. */
	assessable: boolean;

	createdAt: IsoTime;
	updatedAt: IsoTime;
}

// ============================================================================
// User knowledge state
// ============================================================================

export type Exposure = "unseen" | "mentioned" | "studied" | "practiced";
export type Mastery = "unknown" | "missing" | "partial" | "unstable" | "stable";

export interface Misconception {
	id: string;
	description: string;
	status: "active" | "resolved";
	evidenceIds: string[];
	updatedAt: IsoTime;
}

/**
 * The AI-consumed projection of a user's relationship to one knowledge node.
 * Uniquely keyed by (userId, knowledgeNodeId). Derived conservatively from
 * evidence; never written directly by the Actor or Memory Agent.
 */
export interface UserKnowledgeState {
	id: string;
	userId: string;
	knowledgeNodeId: string;

	exposure: Exposure;
	mastery: Mastery;

	misconceptions: Misconception[];

	evidenceIds: string[];
	nextTeachingHint?: string;

	/** Monotonically increasing; used for NotePatch idempotency (sourceStateVersion). */
	version: number;

	lastStudiedAt?: IsoTime;
	lastAssessedAt?: IsoTime;
	createdAt: IsoTime;
	updatedAt: IsoTime;
}

// ============================================================================
// Learning evidence
// ============================================================================

export type EvidenceSource = "prior_knowledge" | "learning_outcome" | "self_report" | "delayed_recall";
export type EvidenceResult = "correct" | "partially_correct" | "incorrect" | "unclear";

/**
 * An append-only fact that supports a state judgement. Evidence is the source of
 * truth; UserKnowledgeState is its current projection.
 */
export interface LearningEvidence {
	id: string;
	/** Deterministic idempotency key: checkpointId + goalRef + source + ordinal. */
	observationId: string;

	userId: string;
	knowledgeNodeId: string;
	sessionId: string;
	turnId: string;

	source: EvidenceSource;

	summary: string;
	result: EvidenceResult;
	/** Whether the user was prompted/hinted when they produced this. */
	prompted: boolean;
	confidence: number;

	observedAt: IsoTime;
}

// ============================================================================
// Planner output
// ============================================================================

/**
 * A concept the Planner proposes to teach. Candidates are not tree nodes; they
 * only become nodes if real learning evidence is later produced for them.
 */
export interface KnowledgeCandidate {
	name: string;
	definition: string;
	learningGoals?: string[];
	/** Suggested catalogue path, root-first, e.g. ["JavaScript", "异步编程"]. */
	suggestedParentPath?: string[];
}

export type PrerequisiteUserState = "known" | "weak" | "unknown";
export type PrerequisiteAction = "use" | "diagnose" | "offer_remediation";

/**
 * Compiled teaching decisions for one lesson run. goalRefs give the Actor stable
 * references without constraining teaching into fixed steps.
 */
export interface TeachingPlan {
	id: string;
	lessonRunId: string;
	target: KnowledgeCandidate;

	goals: Array<{
		ref: string;
		candidate: KnowledgeCandidate;
		matchedNodeId?: string;
		successCriteria: string[];
	}>;

	prerequisites: Array<{
		goalRef: string;
		userState: PrerequisiteUserState;
		action: PrerequisiteAction;
		reason: string;
	}>;

	approach: string;
	createdAt: IsoTime;
}

// ============================================================================
// Lesson run
// ============================================================================

export interface LessonRun {
	id: string;
	userId: string;
	sessionId: string;
	target: string;
	planId?: string;
	status: "active" | "stopped";
	createdAt: IsoTime;
	updatedAt: IsoTime;
}

// ============================================================================
// Checkpoint job
// ============================================================================

export type CheckpointStatus =
	| "captured"
	| "processing"
	| "memory_committed"
	| "note_applied"
	| "completed"
	| "needs_review";

/**
 * A durable, module-level unit of work created by the Actor's `learning_checkpoint`
 * tool. The Actor never writes formal memory; it only creates one of these. The
 * `toEntryId` is finalized at `agent_settled` to the run's last assistant message,
 * so the Memory Agent sees the Actor's final explanation and feedback.
 */
export interface CheckpointJob {
	id: string;
	/** Deterministic identity key (see checkpoint-service). Enforced unique. */
	identityKey: string;

	userId: string;
	sessionId: string;
	lessonRunId: string;
	planId: string;

	moduleTitle: string;
	goalRefs: string[];
	reason: string;

	fromEntryId: string;
	toEntryId?: string;

	status: CheckpointStatus;

	attemptCount: number;
	leaseUntil?: IsoTime;
	createdAt: IsoTime;
	updatedAt: IsoTime;
}

// ============================================================================
// Teaching artifact
// ============================================================================

/**
 * What was actually, externally taught in a checkpoint. Records executed teaching
 * (never hidden reasoning) so notes can be written with real teaching context.
 */
export interface TeachingArtifact {
	checkpointId: string;
	sessionId: string;
	fromEntryId: string;
	toEntryId: string;

	moduleTitle: string;
	goalRefs: string[];
	teachingSummary: string;
	conceptsExplained: string[];
	examplesUsed: string[];
	exercisesUsed: string[];
	canonicalTakeaways: string[];
}

// ============================================================================
// Memory Agent -> Committer proposals
// ============================================================================

/**
 * A single structured judgement the Memory Agent submits to the Committer. The
 * Committer, not the agent, decides node identity and final mastery.
 */
export interface EvidenceProposalItem {
	goalRef: string;
	candidate: KnowledgeCandidate;
	/** Optional explicit node the agent believes this aligns to. */
	matchedNodeId?: string;

	source: EvidenceSource;
	summary: string;
	result: EvidenceResult;
	prompted: boolean;
	confidence: number;
	turnId: string;

	/** Proposed (not authoritative) mastery; Committer reduces conservatively. */
	proposedMastery: Mastery;
	misconception?: string;
	/** True when a previously-seen misconception appears resolved by this evidence. */
	resolvesMisconception?: boolean;
}

export interface EvidenceProposal {
	checkpointId: string;
	artifact: TeachingArtifact;
	items: EvidenceProposalItem[];
}

// ============================================================================
// Committer output
// ============================================================================

export interface CommitResult {
	checkpointId: string;
	resolvedNodeIds: string[];
	createdNodeIds: string[];
	evidenceIds: string[];
	changedStates: UserKnowledgeState[];
	dirtyNoteUnitIds: string[];
	/** Node candidates that could not be uniquely aligned. */
	needsReview: Array<{ goalRef: string; reason: string }>;
}

// ============================================================================
// Notes
// ============================================================================

export interface NoteUpdateRequest {
	checkpointId: string;
	knowledgeUnitId: string;
	sourceStateVersion: number;
}

export interface NotePatchSection {
	knowledgeUnitId: string;
	title: string;
	markdown: string;
}

export interface NotePatch {
	noteId: string;
	topicNodeId: string;
	upsertSections: NotePatchSection[];
}

export type NotePatchStatus = "pending" | "applied" | "conflict";

export interface NotePatchJob {
	id: string;
	checkpointId: string;
	noteId: string;
	knowledgeUnitId: string;
	sourceStateVersion: number;
	patch: NotePatch;
	status: NotePatchStatus;
	createdAt: IsoTime;
	appliedAt?: IsoTime;
}

/** Note file identity + which knowledge units it owns (from frontmatter). */
export interface NoteMeta {
	id: string;
	topicNodeId: string;
	knowledgeUnitIds: string[];
	path: string;
	updatedAt: IsoTime;
}
