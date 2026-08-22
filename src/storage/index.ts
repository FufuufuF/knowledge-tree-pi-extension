/**
 * Storage facade: opens the database once and exposes the three stores plus the
 * shared transaction helper. This is the single object the rest of the extension
 * threads through.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { Db } from "./sqlite.ts";
import { openDatabase, transaction } from "./sqlite.ts";
import { CatalogStore } from "./catalog.ts";
import { CheckpointStore } from "./checkpoint-store.ts";
import { NoteStore } from "./note-store.ts";

export interface StorageLayout {
	/** Root, e.g. ~/.pi/agent/byte-mentor */
	root: string;
	dbPath: string;
	notesDir: string;
}

export function defaultLayout(agentDir?: string): StorageLayout {
	const root = agentDir ?? join(homedir(), ".pi", "agent", "byte-mentor");
	return {
		root,
		dbPath: join(root, "memory.sqlite"),
		notesDir: join(root, "notes"),
	};
}

export class Storage {
	readonly db: Db;
	readonly catalog: CatalogStore;
	readonly checkpoints: CheckpointStore;
	readonly notes: NoteStore;
	readonly layout: StorageLayout;

	constructor(layout: StorageLayout) {
		this.layout = layout;
		this.db = openDatabase(layout.dbPath);
		this.catalog = new CatalogStore(this.db);
		this.checkpoints = new CheckpointStore(this.db);
		this.notes = new NoteStore(this.db);
	}

	/** Run a synchronous unit of work atomically. */
	transaction<T>(fn: () => T): T {
		return transaction(this.db, fn);
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			// already closed
		}
	}
}

export { CatalogStore, CheckpointStore, NoteStore };
export * from "./sqlite.ts";
