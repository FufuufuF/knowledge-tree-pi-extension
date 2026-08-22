/**
 * Conservative state reduction.
 *
 * The Memory Committer never trusts the Memory Agent's proposed mastery. Instead
 * it recomputes UserKnowledgeState from the full evidence list using the ladder
 * defined in the design (memory-requirements.md §11.4 / pi-mvp-design.md §7):
 *
 *   self-report only                         -> unknown / mentioned
 *   pre-teaching unprompted correct once     -> partial
 *   post-teaching prompted correct           -> partial
 *   multiple independent corrects            -> unstable or stable
 *   delayed recall still independent correct -> stable
 *   same misconception re-appears            -> downgrade + reactivate
 *
 * Mastery may go DOWN (forgetting, misconception relapse, new contradicting
 * evidence). Thresholds are configurable, not baked into the domain types.
 */

import type {
	Exposure,
	LearningEvidence,
	Mastery,
	Misconception,
	UserKnowledgeState,
} from "./types.ts";
import { newId, now } from "./ids.ts";

export interface ReducerConfig {
	/** Independent (unprompted) corrects needed to reach `unstable`. */
	unstableThreshold: number;
	/** Independent corrects needed to reach `stable` (without delayed recall). */
	stableThreshold: number;
}

export const DEFAULT_REDUCER_CONFIG: ReducerConfig = {
	unstableThreshold: 2,
	stableThreshold: 3,
};

/** An "independent correct" = correct/partially-correct AND not prompted. */
function isIndependentCorrect(e: LearningEvidence): boolean {
	return !e.prompted && (e.result === "correct" || e.result === "partially_correct");
}

function isAnyCorrect(e: LearningEvidence): boolean {
	return e.result === "correct" || e.result === "partially_correct";
}

const EXPOSURE_RANK: Record<Exposure, number> = {
	unseen: 0,
	mentioned: 1,
	studied: 2,
	practiced: 3,
};

function maxExposure(a: Exposure, b: Exposure): Exposure {
	return EXPOSURE_RANK[a] >= EXPOSURE_RANK[b] ? a : b;
}

/** Exposure implied by a single piece of evidence. */
function exposureFromEvidence(e: LearningEvidence): Exposure {
	switch (e.source) {
		case "self_report":
			return "mentioned";
		case "prior_knowledge":
			return "studied";
		case "learning_outcome":
			// answering a question/exercise is practice
			return "practiced";
		case "delayed_recall":
			return "practiced";
	}
}

export interface ReduceInput {
	/** Existing state, if any (for created/last* timestamps and misconception continuity). */
	previous?: UserKnowledgeState;
	userId: string;
	knowledgeNodeId: string;
	/** All evidence for this (user, node), chronological. Includes newly-added rows. */
	evidence: LearningEvidence[];
	/** Misconception descriptions freshly observed in this commit (active). */
	newMisconceptions?: string[];
	/** Misconception descriptions the new evidence appears to resolve. */
	resolvedMisconceptions?: string[];
	config?: ReducerConfig;
}

/**
 * Recompute a UserKnowledgeState from evidence. Pure — no I/O. The caller
 * persists the result and is responsible for bumping nothing else.
 */
export function reduceState(input: ReduceInput): UserKnowledgeState {
	const cfg = input.config ?? DEFAULT_REDUCER_CONFIG;
	const ts = now();
	const evidence = input.evidence;

	// --- exposure ------------------------------------------------------------
	let exposure: Exposure = input.previous?.exposure ?? "unseen";
	for (const e of evidence) exposure = maxExposure(exposure, exposureFromEvidence(e));

	// --- mastery -------------------------------------------------------------
	const independentCorrects = evidence.filter(isIndependentCorrect).length;
	const anyCorrect = evidence.some(isAnyCorrect);
	const hasIncorrect = evidence.some((e) => e.result === "incorrect");
	const hasDelayedIndependentCorrect = evidence.some(
		(e) => e.source === "delayed_recall" && isIndependentCorrect(e),
	);
	const onlySelfReport = evidence.length > 0 && evidence.every((e) => e.source === "self_report");

	let mastery: Mastery = "unknown";
	if (evidence.length === 0) {
		mastery = input.previous?.mastery ?? "unknown";
	} else if (onlySelfReport) {
		// self-report alone never proves mastery
		mastery = "unknown";
	} else if (hasDelayedIndependentCorrect && independentCorrects >= cfg.unstableThreshold) {
		mastery = "stable";
	} else if (independentCorrects >= cfg.stableThreshold) {
		mastery = "stable";
	} else if (independentCorrects >= cfg.unstableThreshold) {
		mastery = "unstable";
	} else if (anyCorrect) {
		mastery = "partial";
	} else if (hasIncorrect) {
		mastery = "missing";
	} else {
		mastery = "unknown";
	}

	// --- misconceptions ------------------------------------------------------
	const misconceptions: Misconception[] = (input.previous?.misconceptions ?? []).map((m) => ({ ...m }));

	const resolvedSet = new Set((input.resolvedMisconceptions ?? []).map((d) => d.trim().toLowerCase()));
	for (const m of misconceptions) {
		if (resolvedSet.has(m.description.trim().toLowerCase())) {
			m.status = "resolved";
			m.updatedAt = ts;
		}
	}

	for (const desc of input.newMisconceptions ?? []) {
		const key = desc.trim().toLowerCase();
		if (!key) continue;
		const existing = misconceptions.find((m) => m.description.trim().toLowerCase() === key);
		if (existing) {
			// same misconception re-appears -> reactivate
			existing.status = "active";
			existing.updatedAt = ts;
		} else {
			misconceptions.push({
				id: newId("mis"),
				description: desc.trim(),
				status: "active",
				evidenceIds: [],
				updatedAt: ts,
			});
		}
	}

	// Re-appearing (active) misconception forces a downgrade: never leave a node
	// at unstable/stable while a misconception is unresolved.
	const hasActiveMisconception = misconceptions.some((m) => m.status === "active");
	if (hasActiveMisconception && (mastery === "stable" || mastery === "unstable")) {
		mastery = "partial";
	}

	// --- assemble ------------------------------------------------------------
	const evidenceIds = evidence.map((e) => e.id);
	const lastAssessed = evidence.some((e) => e.source !== "self_report")
		? (evidence[evidence.length - 1]?.observedAt ?? ts)
		: input.previous?.lastAssessedAt;

	return {
		id: input.previous?.id ?? newId("state"),
		userId: input.userId,
		knowledgeNodeId: input.knowledgeNodeId,
		exposure,
		mastery,
		misconceptions,
		evidenceIds,
		nextTeachingHint: input.previous?.nextTeachingHint,
		version: (input.previous?.version ?? 0) + 1,
		lastStudiedAt: ts,
		lastAssessedAt: lastAssessed,
		createdAt: input.previous?.createdAt ?? ts,
		updatedAt: ts,
	};
}
