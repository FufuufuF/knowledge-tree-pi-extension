/**
 * TEMPORARY end-to-end probe (delete after verification).
 *
 * Loads inside pi so virtual modules (pi-ai / pi-coding-agent) resolve and we get
 * a real `ctx.model` bound to the codemax provider. On session_start it drives the
 * Planner directly and prints the outcome to stderr, then the Memory agent path if
 * a plan is produced. This bypasses the `-p` lifecycle race where the main agent
 * exits before async isolated agents finish.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Storage, defaultLayout } from "./src/storage/index.ts";
import { runPlanner } from "./src/agents/planner-agent.ts";

const log = (...a: unknown[]) => console.error("[PROBE]", ...a);

export default function probe(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		try {
			const m = (ctx as any).model;
			log("session_start; model =", m?.id, "provider =", m?.provider);
			log("model keys:", m ? Object.keys(m).join(",") : "NONE");
			const storage = new Storage(defaultLayout());
			const target = process.env.PROBE_TARGET ?? "JavaScript 事件循环基础";

			const run = {
				id: "probe-run-1",
				userId: "local",
				sessionId: "probe-sess",
				target,
				status: "active" as const,
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
			};
			storage.checkpoints.insertLessonRun(run);

			// Minimal isolation repro to localize the startsWith crash.
			try {
				const { createIsolatedAgent } = await import("./src/pi/runtime-factory.ts");
				log("creating bare isolated agent…");
				const bare = await createIsolatedAgent({
					cwd: ctx.cwd,
					model: m,
					customTools: [],
					systemPrompt: "You are a test. Reply with the single word OK.",
					signal: (ctx as any).signal,
				});
				log("bare agent created; running…");
				await bare.run("Say OK.");
				log("bare agent ran OK");
				bare.dispose();
			} catch (e) {
				log("BARE AGENT FAILED:", e instanceof Error ? e.message : String(e));
				log("STACK:\n" + (e instanceof Error ? e.stack : ""));
			}

			log("invoking Planner for target:", target);
			const t0 = Date.now();
			const plan = await runPlanner({
				storage,
				userId: "local",
				lessonRunId: run.id,
				target,
				cwd: ctx.cwd,
				model: (ctx as any).model,
				signal: (ctx as any).signal,
			});
			log("Planner returned in", Date.now() - t0, "ms");

			if (!plan) {
				log("RESULT: NO PLAN produced (sink empty)");
			} else {
				log("RESULT: PLAN OK");
				log("  target:", JSON.stringify(plan.target));
				log("  goals:", plan.goals.length);
				log("  goal titles:", plan.goals.map((g: any) => g.title ?? g.name ?? g.ref).join(" | "));
				log("  approach:", (plan.approach ?? "").slice(0, 200));
			}
			storage.close();
		} catch (err) {
			log("PLANNER THREW:", err instanceof Error ? (err.stack ?? err.message) : String(err));
		}
	});
}
