/**
 * Memory Committer — the single transactional boundary and anti-corruption layer
 * for formal long-term memory (design §7 / §11).
 *
 * On one successful `submit_evidence_proposal` it, in ONE SQLite transaction:
 *   1. validates ownership (checkpoint / lesson run / goalRefs).
 *   2. aligns each candidate to an existing node (exact -> normalized keyword ->
 *      small-candidate semantic check delegated upstream) or lazily creates one
 *      (with necessary ancestors) only when real evidence exists.
 *   3. records ambiguous candidates as needs_review instead of silently
 *      duplicating nodes.
 *   4. appends evidence idempotently by observationId.
 *   5. conservatively reduces UserKnowledgeState from ALL evidence.
 *   6. writes TeachingArtifact + NoteUpdateRequest.
 *   7. saves CommitResult and advances the job to memory_committed.
 *
 * Idempotency: re-committing the same checkpoint returns the stored CommitResult
 * without producing duplicate evidence (design §9.2).
 */

import type {
	CommitResult,
	EvidenceProposal,
	EvidenceProposalItem,
	KnowledgeCandidate,
	LearningEvidence,
	UserKnowledgeState,
} from "./types.ts";
import type { Storage } from "../storage/index.ts";
import { newId, normalizeText, now, stableKey } from "./ids.ts";
import { reduceState, type ReducerConfig } from "./state-reducer.ts";

export interface CommitterConfig {
	reducer?: ReducerConfig;
}

export interface AlignmentResolver {
	/**
	 * Optional semantic tie-breaker for a small candidate set. Returns the id of
	 * the matching node, or undefined for "none match / ambiguous". When omitted,
	 * the committer treats >1 normalized candidates as ambiguous (needs_review).
	 */
	resolve?: (candidate: KnowledgeCandidate, candidates: Array<{ id: string; name: string }>) => string | undefined;
}

type AlignOutcome =
	| { kind: "resolved"; nodeId: string }
	| { kind: "created"; nodeId: string }
	| { kind: "needs_review"; reason: string };

export class MemoryCommitter {
	private readonly storage: Storage;
	private readonly config: CommitterConfig;
	private readonly resolver: AlignmentResolver;

	constructor(storage: Storage, config: CommitterConfig = {}, resolver: AlignmentResolver = {}) {
		this.storage = storage;
		this.config = config;
		this.resolver = resolver;
	}

	/**
	 * Commit a proposal for a checkpoint. Idempotent by checkpointId.
	 */
	commit(proposal: EvidenceProposal): CommitResult {
		const { checkpoints, catalog } = this.storage;

		const job = checkpoints.getJob(proposal.checkpointId);
		if (!job) throw new Error(`commit: unknown checkpoint ${proposal.checkpointId}`);

		// Idempotency short-circuit: already committed -> return stored result.
		const prior = checkpoints.getCommitResult(proposal.checkpointId);
		if (prior && (job.status === "memory_committed" || job.status === "note_applied" || job.status === "completed")) {
			return prior;
		}

		// Validate goalRefs belong to the job.
		const jobGoalRefs = new Set(job.goalRefs);
		for (const item of proposal.items) {
			if (!jobGoalRefs.has(item.goalRef)) {
				throw new Error(`commit: goalRef "${item.goalRef}" not part of checkpoint ${job.id}`);
			}
		}

		return this.storage.transaction<CommitResult>(() => {
			const result: CommitResult = {
				checkpointId: job.id,
				resolvedNodeIds: [],
				createdNodeIds: [],
				evidenceIds: [],
				changedStates: [],
				dirtyNoteUnitIds: [],
				needsReview: [],
			};

			// Group items by aligned node so state is reduced once per node.
			const touchedNodes = new Set<string>();
			const newMisconceptionsByNode = new Map<string, string[]>();
			const resolvedMisconceptionsByNode = new Map<string, string[]>();

			let ordinal = 0;
			for (const item of proposal.items) {
				ordinal++;
				const outcome = this.alignCandidate(item);

				if (outcome.kind === "needs_review") {
					result.needsReview.push({ goalRef: item.goalRef, reason: outcome.reason });
					continue;
				}

				const nodeId = outcome.nodeId;
				if (outcome.kind === "created") result.createdNodeIds.push(nodeId);
				else if (!result.resolvedNodeIds.includes(nodeId)) result.resolvedNodeIds.push(nodeId);

				// Evidence idempotency: observationId = checkpoint + goalRef + source + ordinal.
				const observationId = stableKey(job.id, item.goalRef, item.source, ordinal);
				const existing = catalog.getEvidenceByObservation(observationId);
				if (existing) {
					result.evidenceIds.push(existing.id);
				} else {
					const ev: LearningEvidence = {
						id: newId("ev"),
						observationId,
						userId: job.userId,
						knowledgeNodeId: nodeId,
						sessionId: job.sessionId,
						turnId: item.turnId,
						source: item.source,
						summary: item.summary,
						result: item.result,
						prompted: item.prompted,
						confidence: item.confidence,
						observedAt: now(),
					};
					catalog.insertEvidence(ev);
					result.evidenceIds.push(ev.id);
				}

				touchedNodes.add(nodeId);
				if (item.misconception) {
					const list = newMisconceptionsByNode.get(nodeId) ?? [];
					list.push(item.misconception);
					newMisconceptionsByNode.set(nodeId, list);
				}
				if (item.resolvesMisconception && item.misconception) {
					const list = resolvedMisconceptionsByNode.get(nodeId) ?? [];
					list.push(item.misconception);
					resolvedMisconceptionsByNode.set(nodeId, list);
				}
			}

			// Reduce state per touched node from the FULL evidence list.
			for (const nodeId of touchedNodes) {
				const previous = catalog.getState(job.userId, nodeId);
				const evidence = catalog.listEvidence(job.userId, nodeId);
				const reduced: UserKnowledgeState = reduceState({
					previous,
					userId: job.userId,
					knowledgeNodeId: nodeId,
					evidence,
					newMisconceptions: newMisconceptionsByNode.get(nodeId),
					resolvedMisconceptions: resolvedMisconceptionsByNode.get(nodeId),
					config: this.config.reducer,
				});
				catalog.upsertState(reduced);
				result.changedStates.push(reduced);
			}

			// Persist artifact + note update requests (dirty note units).
			checkpoints.saveArtifact(proposal.artifact);
			for (const state of result.changedStates) {
				const unitId = state.knowledgeNodeId;
				result.dirtyNoteUnitIds.push(unitId);
				checkpoints.saveNoteUpdateRequest({
					checkpointId: job.id,
					knowledgeUnitId: unitId,
					sourceStateVersion: state.version,
				});
			}

			checkpoints.saveCommitResult(result);
			// Advance job: needs_review only if nothing committed AND ambiguity remains.
			if (result.changedStates.length === 0 && result.needsReview.length > 0) {
				checkpoints.setJobStatus(job.id, "needs_review");
			} else {
				checkpoints.setJobStatus(job.id, "memory_committed");
			}
			return result;
		});
	}

	/**
	 * Align one candidate to a node. Runs inside the commit transaction:
	 *   exact id -> normalized-name (scoped to resolved parent) -> resolver tie
	 *   -> lazy create (+ ancestor topics) -> needs_review on ambiguity.
	 */
	private alignCandidate(item: EvidenceProposalItem): AlignOutcome {
		const { catalog } = this.storage;
		const cand = item.candidate;

		// 1. explicit matched node.
		if (item.matchedNodeId) {
			const node = catalog.getNode(item.matchedNodeId);
			if (node) return { kind: "resolved", nodeId: node.id };
		}

		// 2. resolve suggested parent path (creating ancestor topics as needed).
		const parentId = this.resolveParentPath(cand.suggestedParentPath);

		// 3. normalized-name match within parent scope.
		const scoped = catalog.findByNormalizedName(cand.name, parentId);
		if (scoped.length === 1) {
			const only = scoped[0];
			if (only) return { kind: "resolved", nodeId: only.id };
		}
		if (scoped.length > 1) {
			const chosen = this.resolver.resolve?.(
				cand,
				scoped.map((n) => ({ id: n.id, name: n.name })),
			);
			if (chosen && scoped.some((n) => n.id === chosen)) return { kind: "resolved", nodeId: chosen };
			return { kind: "needs_review", reason: `multiple nodes match "${cand.name}" under the same parent` };
		}

		// 4. global normalized-name match (ambiguous across parents -> review).
		if (!parentId) {
			const global = catalog.findByNormalizedName(cand.name);
			if (global.length === 1) {
				const only = global[0];
				if (only) return { kind: "resolved", nodeId: only.id };
			}
			if (global.length > 1) {
				return { kind: "needs_review", reason: `"${cand.name}" is ambiguous across multiple topics` };
			}
		}

		// 5. lazy create — only reached because this candidate carries real
		//    learning evidence (the caller only aligns items being committed).
		if (!cand.name.trim() || !cand.definition.trim()) {
			return { kind: "needs_review", reason: `candidate "${cand.name}" lacks name/definition for creation` };
		}
		const created = catalog.createNode({
			name: cand.name,
			definition: cand.definition,
			learningGoals: cand.learningGoals,
			parentId,
			assessable: true,
		});
		return { kind: "created", nodeId: created.id };
	}

	/**
	 * Resolve (or create) the chain of topic nodes named by a suggested path.
	 * Returns the id of the deepest node, or undefined for a root-level concept.
	 * Ancestors are created as non-leaf topics; the leaf itself is NOT created here.
	 */
	private resolveParentPath(path?: string[]): string | undefined {
		if (!path || path.length === 0) return undefined;
		const { catalog } = this.storage;
		let parentId: string | undefined;
		for (const rawName of path) {
			const name = rawName.trim();
			if (!name) continue;
			const matches = catalog.findByNormalizedName(name, parentId).filter((n) => normalizeText(n.name) === normalizeText(name));
			const found = matches[0];
			if (found) {
				parentId = found.id;
			} else {
				const created = catalog.createNode({
					name,
					definition: `${name} (topic)`,
					parentId,
					assessable: false,
				});
				parentId = created.id;
			}
		}
		return parentId;
	}
}
