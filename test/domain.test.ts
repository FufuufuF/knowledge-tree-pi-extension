/**
 * Deterministic-core tests: committer, reducer, checkpoint idempotency, and the
 * note patch applier. These cover the reliability boundaries from pi-mvp-design
 * §7/§9 and memory-requirements §11 without any LLM or Pi runtime.
 *
 * Run: node --test --experimental-strip-types test/domain.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Storage } from "../src/storage/index.ts";
import { MemoryCommitter } from "../src/domain/memory-committer.ts";
import { CheckpointService, checkpointIdentity } from "../src/domain/checkpoint-service.ts";
import { reduceState } from "../src/domain/state-reducer.ts";
import { NotePatchApplier } from "../src/notes/patch-applier.ts";
import type { EvidenceProposalItem, LearningEvidence, TeachingArtifact } from "../src/domain/types.ts";

function freshStorage(): Storage {
	const dir = mkdtempSync(join(tmpdir(), "bm-test-"));
	return new Storage({ root: dir, dbPath: join(dir, "memory.sqlite"), notesDir: join(dir, "notes") });
}

function makeArtifact(checkpointId: string): TeachingArtifact {
	return {
		checkpointId,
		sessionId: "sess",
		fromEntryId: "from",
		toEntryId: "to",
		moduleTitle: "M",
		goalRefs: ["g1"],
		teachingSummary: "s",
		conceptsExplained: [],
		examplesUsed: [],
		exercisesUsed: [],
		canonicalTakeaways: [],
	};
}

function baseItem(over: Partial<EvidenceProposalItem> = {}): EvidenceProposalItem {
	return {
		goalRef: "g1",
		candidate: { name: "Event Loop", definition: "d", suggestedParentPath: ["JavaScript"] },
		source: "learning_outcome",
		summary: "s",
		result: "correct",
		prompted: false,
		confidence: 0.9,
		turnId: "t1",
		proposedMastery: "stable",
		...over,
	};
}

function setupJob(s: Storage, n = 1) {
	const cps = new CheckpointService(s.checkpoints);
	s.checkpoints.insertLessonRun({
		id: `run${n}`,
		userId: "u",
		sessionId: "sess",
		target: "EL",
		planId: "plan1",
		status: "active",
		createdAt: "t",
		updatedAt: "t",
	});
	const job = cps.capture({
		userId: "u",
		sessionId: "sess",
		lessonRunId: `run${n}`,
		planId: "plan1",
		moduleTitle: "M",
		goalRefs: ["g1"],
		reason: "r",
		fromEntryId: `from${n}`,
	});
	cps.finalizeRange(job.id, `to${n}`);
	return job;
}

test("committer: lazy-creates node under path and keeps misconception active", () => {
	const s = freshStorage();
	const job = setupJob(s);
	const committer = new MemoryCommitter(s);
	const r = committer.commit({
		checkpointId: job.id,
		artifact: makeArtifact(job.id),
		items: [baseItem({ result: "incorrect", proposedMastery: "missing", misconception: "async = new thread" })],
	});
	assert.equal(r.createdNodeIds.length, 1);
	assert.equal(r.changedStates.length, 1);
	assert.equal(r.changedStates[0]!.mastery, "missing");
	assert.equal(r.changedStates[0]!.misconceptions[0]!.status, "active");
	s.close();
});

test("committer: idempotent re-commit yields no duplicate evidence", () => {
	const s = freshStorage();
	const job = setupJob(s);
	const committer = new MemoryCommitter(s);
	const r1 = committer.commit({ checkpointId: job.id, artifact: makeArtifact(job.id), items: [baseItem()] });
	const r2 = committer.commit({ checkpointId: job.id, artifact: makeArtifact(job.id), items: [baseItem()] });
	assert.deepEqual(r1.evidenceIds, r2.evidenceIds);
	assert.equal(s.catalog.listEvidence("u", r1.createdNodeIds[0]!).length, 1);
	s.close();
});

test("committer: mastery ladder partial -> unstable -> stable via delayed recall", () => {
	const s = freshStorage();
	const committer = new MemoryCommitter(s);
	const run = (n: number, over: Partial<EvidenceProposalItem>) => {
		const job = setupJob(s, n);
		return committer.commit({ checkpointId: job.id, artifact: makeArtifact(job.id), items: [baseItem(over)] });
	};
	assert.equal(run(1, { prompted: true }).changedStates[0]!.mastery, "partial");
	assert.equal(run(2, { prompted: false }).changedStates[0]!.mastery, "partial");
	assert.equal(run(3, { prompted: false }).changedStates[0]!.mastery, "unstable");
	assert.equal(run(4, { prompted: false, source: "delayed_recall" }).changedStates[0]!.mastery, "stable");
	s.close();
});

test("reducer: self-report alone never reaches mastery", () => {
	const ev: LearningEvidence[] = [
		{
			id: "e1",
			observationId: "o1",
			userId: "u",
			knowledgeNodeId: "n",
			sessionId: "s",
			turnId: "t",
			source: "self_report",
			summary: "我会",
			result: "correct",
			prompted: false,
			confidence: 0.5,
			observedAt: "t",
		},
	];
	const state = reduceState({ userId: "u", knowledgeNodeId: "n", evidence: ev });
	assert.equal(state.mastery, "unknown");
	assert.equal(state.exposure, "mentioned");
});

test("checkpoint identity is stable and range-sensitive", () => {
	const base = {
		sessionId: "s",
		fromEntryId: "a",
		planId: "p",
		moduleTitle: "m",
		goalRefs: ["g2", "g1"],
	};
	const k1 = checkpointIdentity({ ...base });
	const k2 = checkpointIdentity({ ...base, goalRefs: ["g1", "g2"] });
	const k3 = checkpointIdentity({ ...base, toEntryId: "z" });
	assert.equal(k1, k2, "goalRef order must not matter");
	assert.notEqual(k1, k3, "toEntryId must affect identity");
});

test("checkpoint capture is idempotent for identical range", () => {
	const s = freshStorage();
	const cps = new CheckpointService(s.checkpoints);
	s.checkpoints.insertLessonRun({
		id: "run1",
		userId: "u",
		sessionId: "sess",
		target: "EL",
		planId: "plan1",
		status: "active",
		createdAt: "t",
		updatedAt: "t",
	});
	const input = {
		userId: "u",
		sessionId: "sess",
		lessonRunId: "run1",
		planId: "plan1",
		moduleTitle: "M",
		goalRefs: ["g1"],
		reason: "r",
		fromEntryId: "from1",
	};
	const a = cps.capture(input);
	const b = cps.capture(input);
	assert.equal(a.id, b.id);
	s.close();
});

test("note applier: create -> replace -> conflict, preserving user edits", () => {
	const s = freshStorage();
	const applier = new NotePatchApplier(s.layout.notesDir);
	const meta = {
		id: "note-x",
		topicNodeId: "t",
		knowledgeUnitIds: ["u1"],
		path: "x.md",
		updatedAt: "t",
	};
	const mk = (body: string) => ({
		noteId: "note-x",
		topicNodeId: "t",
		upsertSections: [{ knowledgeUnitId: "u1", title: "T", markdown: body }],
	});

	const r1 = applier.apply(meta, mk("v1"), {});
	assert.equal(r1.status, "applied");
	assert.equal(r1.units[0]!.outcome, "created");

	const r2 = applier.apply(meta, mk("v2"), r1.newHashes);
	assert.equal(r2.units[0]!.outcome, "replaced");

	// simulate an out-of-band edit by passing a stale expected hash
	const r3 = applier.apply(meta, mk("v3"), { u1: "deadbeef" });
	assert.equal(r3.status, "conflict");
	assert.equal(r3.units[0]!.outcome, "conflict");
	s.close();
});
