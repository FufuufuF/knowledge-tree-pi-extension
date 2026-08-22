/**
 * Note Patch Applier — the sole writer of user Markdown (design §8 / §12).
 *
 * It only inserts or replaces content BETWEEN controlled markers:
 *
 *   <!-- byte-mentor:unit:<unitId>:start -->
 *   ...AI-managed block...
 *   <!-- byte-mentor:unit:<unitId>:end -->
 *
 * Content outside markers (including user-authored prose) is never touched. If a
 * managed block's on-disk content hash no longer matches what we last wrote, the
 * patch is flagged `conflict` and the file is left intact for the user to resolve.
 *
 * Writes are atomic: render the full file to a temp path, then rename over the
 * original.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NoteMeta, NotePatch, NotePatchSection } from "../domain/types.ts";
import { contentHash, now } from "../domain/ids.ts";

const MARKER_PREFIX = "byte-mentor:unit:";

function startMarker(unitId: string): string {
	return `<!-- ${MARKER_PREFIX}${unitId}:start -->`;
}
function endMarker(unitId: string): string {
	return `<!-- ${MARKER_PREFIX}${unitId}:end -->`;
}

export interface ApplyResult {
	status: "applied" | "conflict";
	/** Per-unit outcome for diagnostics. */
	units: Array<{ unitId: string; outcome: "created" | "replaced" | "conflict" }>;
	notePath: string;
}

interface ManagedBlock {
	unitId: string;
	/** Character range in the file [startIdx, endIdx) covering the WHOLE block incl. markers. */
	startIdx: number;
	endIdx: number;
	/** Inner content between markers (used for hash comparison). */
	inner: string;
}

/** Frontmatter (YAML-ish) parse limited to what we author. */
interface Frontmatter {
	id?: string;
	topicNodeId?: string;
	knowledgeUnitIds?: string[];
	updatedAt?: string;
}

export class NotePatchApplier {
	private readonly notesDir: string;

	constructor(notesDir: string) {
		this.notesDir = notesDir;
	}

	/**
	 * Apply a patch. `expectedHashes` maps unitId -> the hash we recorded when we
	 * last wrote that block; if the current on-disk inner hash differs, that unit
	 * is a conflict. Pass an empty map on first write.
	 */
	apply(
		meta: NoteMeta,
		patch: NotePatch,
		expectedHashes: Record<string, string> = {},
	): ApplyResult & { newHashes: Record<string, string> } {
		const notePath = meta.path.startsWith("/") ? meta.path : join(this.notesDir, meta.path);
		mkdirSync(dirname(notePath), { recursive: true });

		let raw = existsSync(notePath) ? readFileSync(notePath, "utf8") : "";
		if (!raw) raw = this.renderEmpty(meta);

		const units: ApplyResult["units"] = [];
		const newHashes: Record<string, string> = { ...expectedHashes };
		let hadConflict = false;

		for (const section of patch.upsertSections) {
			const block = this.findBlock(raw, section.knowledgeUnitId);
			const expected = expectedHashes[section.knowledgeUnitId];

			if (block && expected !== undefined && contentHash(block.inner) !== expected) {
				// user (or something) edited the managed block since we last wrote it
				units.push({ unitId: section.knowledgeUnitId, outcome: "conflict" });
				hadConflict = true;
				continue;
			}

			const rendered = this.renderSection(section);
			const innerHash = contentHash(this.sectionInner(section));

			if (block) {
				raw = raw.slice(0, block.startIdx) + rendered + raw.slice(block.endIdx);
				units.push({ unitId: section.knowledgeUnitId, outcome: "replaced" });
			} else {
				raw = this.appendBlock(raw, rendered);
				units.push({ unitId: section.knowledgeUnitId, outcome: "created" });
			}
			newHashes[section.knowledgeUnitId] = innerHash;
		}

		if (hadConflict && units.every((u) => u.outcome === "conflict")) {
			// nothing safely writable — leave file untouched
			return { status: "conflict", units, notePath, newHashes };
		}

		raw = this.touchFrontmatter(raw, meta);
		this.atomicWrite(notePath, raw);

		return {
			status: hadConflict ? "conflict" : "applied",
			units,
			notePath,
			newHashes,
		};
	}

	// ---- rendering ----------------------------------------------------------

	private renderEmpty(meta: NoteMeta): string {
		const fm = [
			"---",
			`id: ${meta.id}`,
			`topicNodeId: ${meta.topicNodeId}`,
			"knowledgeUnitIds:",
			...meta.knowledgeUnitIds.map((u) => `  - ${u}`),
			`updatedAt: ${now()}`,
			"---",
			"",
		].join("\n");
		return fm;
	}

	/** The inner markdown of a section (without markers), used for hashing. */
	private sectionInner(section: NotePatchSection): string {
		return `\n## ${section.title}\n\n${section.markdown.trim()}\n`;
	}

	private renderSection(section: NotePatchSection): string {
		return `${startMarker(section.knowledgeUnitId)}${this.sectionInner(section)}${endMarker(section.knowledgeUnitId)}`;
	}

	private appendBlock(raw: string, rendered: string): string {
		const trimmed = raw.replace(/\s+$/, "");
		return `${trimmed}\n\n${rendered}\n`;
	}

	// ---- block location -----------------------------------------------------

	private findBlock(raw: string, unitId: string): ManagedBlock | undefined {
		const start = raw.indexOf(startMarker(unitId));
		if (start === -1) return undefined;
		const endMark = endMarker(unitId);
		const endMarkIdx = raw.indexOf(endMark, start);
		if (endMarkIdx === -1) return undefined;
		const endIdx = endMarkIdx + endMark.length;
		const innerStart = start + startMarker(unitId).length;
		return {
			unitId,
			startIdx: start,
			endIdx,
			inner: raw.slice(innerStart, endMarkIdx),
		};
	}

	// ---- frontmatter --------------------------------------------------------

	private touchFrontmatter(raw: string, meta: NoteMeta): string {
		const fm = this.parseFrontmatter(raw);
		if (!fm) {
			// prepend a fresh frontmatter block
			return this.renderEmpty(meta).replace(/\n$/, "\n") + "\n" + raw;
		}
		// rewrite updatedAt + ensure unit ids include all managed units
		const existing = new Set(fm.frontmatter.knowledgeUnitIds ?? []);
		for (const u of meta.knowledgeUnitIds) existing.add(u);
		const lines = [
			"---",
			`id: ${fm.frontmatter.id ?? meta.id}`,
			`topicNodeId: ${fm.frontmatter.topicNodeId ?? meta.topicNodeId}`,
			"knowledgeUnitIds:",
			...Array.from(existing).map((u) => `  - ${u}`),
			`updatedAt: ${now()}`,
			"---",
		].join("\n");
		return lines + raw.slice(fm.endIdx);
	}

	private parseFrontmatter(raw: string): { frontmatter: Frontmatter; endIdx: number } | undefined {
		if (!raw.startsWith("---")) return undefined;
		const end = raw.indexOf("\n---", 3);
		if (end === -1) return undefined;
		const block = raw.slice(3, end);
		const afterFence = raw.indexOf("\n", end + 1);
		const endIdx = afterFence === -1 ? raw.length : afterFence + 1;

		const fm: Frontmatter = {};
		const lines = block.split("\n");
		let collectingUnits = false;
		const units: string[] = [];
		for (const line of lines) {
			const listItem = line.match(/^\s*-\s+(.*)$/);
			if (collectingUnits && listItem) {
				units.push(listItem[1]!.trim());
				continue;
			}
			collectingUnits = false;
			const kv = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/);
			if (!kv) continue;
			const key = kv[1]!;
			const value = kv[2]!.trim();
			if (key === "knowledgeUnitIds") {
				collectingUnits = true;
				if (value) units.push(value);
			} else if (key === "id") fm.id = value;
			else if (key === "topicNodeId") fm.topicNodeId = value;
			else if (key === "updatedAt") fm.updatedAt = value;
		}
		fm.knowledgeUnitIds = units;
		return { frontmatter: fm, endIdx };
	}

	// ---- io -----------------------------------------------------------------

	private atomicWrite(path: string, content: string): void {
		const tmp = `${path}.tmp-${process.pid}`;
		writeFileSync(tmp, content, "utf8");
		renameSync(tmp, path);
	}
}
