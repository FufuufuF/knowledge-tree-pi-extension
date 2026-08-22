/**
 * Catalog store: knowledge tree, user states, and evidence reads/writes.
 *
 * Reads here back the Planner/Memory agent's progressive browsing tools
 * (listChildren / search / getNode / state_get / evidence_get). Writes here are
 * only called from inside the Memory Committer's transaction — this store does
 * NOT open its own transactions.
 */

import type { Db } from "./sqlite.ts";
import type {
	KnowledgeNode,
	LearningEvidence,
	Misconception,
	UserKnowledgeState,
} from "../domain/types.ts";
import { newId, normalizeText, now } from "../domain/ids.ts";

type Row = Record<string, unknown>;

function rowToNode(r: Row): KnowledgeNode {
	return {
		id: r.id as string,
		parentId: (r.parent_id as string | null) ?? undefined,
		name: r.name as string,
		definition: r.definition as string,
		learningGoals: r.learning_goals ? (JSON.parse(r.learning_goals as string) as string[]) : undefined,
		assessable: (r.assessable as number) !== 0,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
	};
}

function rowToState(r: Row): UserKnowledgeState {
	return {
		id: r.id as string,
		userId: r.user_id as string,
		knowledgeNodeId: r.knowledge_node_id as string,
		exposure: r.exposure as UserKnowledgeState["exposure"],
		mastery: r.mastery as UserKnowledgeState["mastery"],
		misconceptions: JSON.parse(r.misconceptions as string) as Misconception[],
		evidenceIds: JSON.parse(r.evidence_ids as string) as string[],
		nextTeachingHint: (r.next_teaching_hint as string | null) ?? undefined,
		version: r.version as number,
		lastStudiedAt: (r.last_studied_at as string | null) ?? undefined,
		lastAssessedAt: (r.last_assessed_at as string | null) ?? undefined,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
	};
}

function rowToEvidence(r: Row): LearningEvidence {
	return {
		id: r.id as string,
		observationId: r.observation_id as string,
		userId: r.user_id as string,
		knowledgeNodeId: r.knowledge_node_id as string,
		sessionId: r.session_id as string,
		turnId: r.turn_id as string,
		source: r.source as LearningEvidence["source"],
		summary: r.summary as string,
		result: r.result as LearningEvidence["result"],
		prompted: (r.prompted as number) !== 0,
		confidence: r.confidence as number,
		observedAt: r.observed_at as string,
	};
}

export class CatalogStore {
	private readonly db: Db;

	constructor(db: Db) {
		this.db = db;
	}

	// ---- knowledge tree (reads) --------------------------------------------

	listChildren(parentId?: string): KnowledgeNode[] {
		const stmt = parentId
			? this.db.prepare("SELECT * FROM knowledge_nodes WHERE parent_id = ? ORDER BY name")
			: this.db.prepare("SELECT * FROM knowledge_nodes WHERE parent_id IS NULL ORDER BY name");
		const rows = (parentId ? stmt.all(parentId) : stmt.all()) as Row[];
		return rows.map(rowToNode);
	}

	getNode(nodeId: string): KnowledgeNode | undefined {
		const r = this.db.prepare("SELECT * FROM knowledge_nodes WHERE id = ?").get(nodeId) as Row | undefined;
		return r ? rowToNode(r) : undefined;
	}

	/** Keyword search over normalized name; optionally scoped to a parent. */
	search(query: string, parentId?: string): KnowledgeNode[] {
		const norm = normalizeText(query);
		const like = `%${norm}%`;
		const rows = parentId
			? (this.db
					.prepare("SELECT * FROM knowledge_nodes WHERE parent_id = ? AND norm_name LIKE ? ORDER BY name LIMIT 25")
					.all(parentId, like) as Row[])
			: (this.db
					.prepare("SELECT * FROM knowledge_nodes WHERE norm_name LIKE ? ORDER BY name LIMIT 25")
					.all(like) as Row[]);
		return rows.map(rowToNode);
	}

	/** Exact match by normalized name, optionally within a parent — for alignment. */
	findByNormalizedName(name: string, parentId?: string): KnowledgeNode[] {
		const norm = normalizeText(name);
		const rows = parentId
			? (this.db
					.prepare("SELECT * FROM knowledge_nodes WHERE parent_id = ? AND norm_name = ? LIMIT 10")
					.all(parentId, norm) as Row[])
			: (this.db.prepare("SELECT * FROM knowledge_nodes WHERE norm_name = ? LIMIT 10").all(norm) as Row[]);
		return rows.map(rowToNode);
	}

	// ---- knowledge tree (writes; committer transaction only) ---------------

	createNode(input: {
		name: string;
		definition: string;
		learningGoals?: string[];
		parentId?: string;
		assessable?: boolean;
	}): KnowledgeNode {
		const ts = now();
		const node: KnowledgeNode = {
			id: newId("node"),
			parentId: input.parentId,
			name: input.name,
			definition: input.definition,
			learningGoals: input.learningGoals,
			assessable: input.assessable ?? true,
			createdAt: ts,
			updatedAt: ts,
		};
		this.db
			.prepare(
				`INSERT INTO knowledge_nodes
				 (id, parent_id, name, definition, learning_goals, assessable, norm_name, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				node.id,
				node.parentId ?? null,
				node.name,
				node.definition,
				node.learningGoals ? JSON.stringify(node.learningGoals) : null,
				node.assessable ? 1 : 0,
				normalizeText(node.name),
				node.createdAt,
				node.updatedAt,
			);
		return node;
	}

	// ---- user knowledge state ----------------------------------------------

	getState(userId: string, knowledgeNodeId: string): UserKnowledgeState | undefined {
		const r = this.db
			.prepare("SELECT * FROM user_knowledge_states WHERE user_id = ? AND knowledge_node_id = ?")
			.get(userId, knowledgeNodeId) as Row | undefined;
		return r ? rowToState(r) : undefined;
	}

	getStateById(id: string): UserKnowledgeState | undefined {
		const r = this.db.prepare("SELECT * FROM user_knowledge_states WHERE id = ?").get(id) as Row | undefined;
		return r ? rowToState(r) : undefined;
	}

	upsertState(state: UserKnowledgeState): void {
		this.db
			.prepare(
				`INSERT INTO user_knowledge_states
				 (id, user_id, knowledge_node_id, exposure, mastery, misconceptions, evidence_ids,
				  next_teaching_hint, version, last_studied_at, last_assessed_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(user_id, knowledge_node_id) DO UPDATE SET
				   exposure = excluded.exposure,
				   mastery = excluded.mastery,
				   misconceptions = excluded.misconceptions,
				   evidence_ids = excluded.evidence_ids,
				   next_teaching_hint = excluded.next_teaching_hint,
				   version = excluded.version,
				   last_studied_at = excluded.last_studied_at,
				   last_assessed_at = excluded.last_assessed_at,
				   updated_at = excluded.updated_at`,
			)
			.run(
				state.id,
				state.userId,
				state.knowledgeNodeId,
				state.exposure,
				state.mastery,
				JSON.stringify(state.misconceptions),
				JSON.stringify(state.evidenceIds),
				state.nextTeachingHint ?? null,
				state.version,
				state.lastStudiedAt ?? null,
				state.lastAssessedAt ?? null,
				state.createdAt,
				state.updatedAt,
			);
	}

	// ---- evidence -----------------------------------------------------------

	getEvidenceByObservation(observationId: string): LearningEvidence | undefined {
		const r = this.db
			.prepare("SELECT * FROM learning_evidence WHERE observation_id = ?")
			.get(observationId) as Row | undefined;
		return r ? rowToEvidence(r) : undefined;
	}

	listEvidence(userId: string, knowledgeNodeId: string): LearningEvidence[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM learning_evidence WHERE user_id = ? AND knowledge_node_id = ? ORDER BY observed_at",
			)
			.all(userId, knowledgeNodeId) as Row[];
		return rows.map(rowToEvidence);
	}

	insertEvidence(ev: LearningEvidence): void {
		this.db
			.prepare(
				`INSERT INTO learning_evidence
				 (id, observation_id, user_id, knowledge_node_id, session_id, turn_id, source,
				  summary, result, prompted, confidence, observed_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				ev.id,
				ev.observationId,
				ev.userId,
				ev.knowledgeNodeId,
				ev.sessionId,
				ev.turnId,
				ev.source,
				ev.summary,
				ev.result,
				ev.prompted ? 1 : 0,
				ev.confidence,
				ev.observedAt,
			);
	}
}
