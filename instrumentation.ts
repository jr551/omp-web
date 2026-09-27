import type { configureHttpDispatcher as ConfigureHttpDispatcher } from "@/lib/http-dispatcher";

type DispatcherModule = { configureHttpDispatcher: typeof ConfigureHttpDispatcher };

export async function register(): Promise<void> {
  // The Routines scheduler must run on the server runtime under Bun. Next may
  // invoke register() with NEXT_RUNTIME set to "nodejs" OR (under `bun next
  // start`) left undefined; only the edge runtime must be skipped. The earlier
  // `!== "nodejs"` guard silently skipped startup under Bun, so cron routines
  // never fired until a manual run started the scheduler lazily.
  if (process.env.NEXT_RUNTIME === "edge") return;

  // Start the native Routines scheduler once per server process. Unlike the
  // http-dispatcher below, this must also run under Bun — Bun is the runtime
  // omp-web actually serves on — so it lives before the Bun guard.
  const { startRoutineScheduler } = await import("@/lib/routine-scheduler");
  startRoutineScheduler();

  // The Node-only http-dispatcher wiring below stays gated to the Node runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (typeof process.versions.bun === "string") return;

  // Keep the Node-only undici graph out of Next's browser/edge instrumentation
  // bundles. Node 22 can load this local TypeScript module directly.
  const importRuntimeModule = Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<DispatcherModule>;
  const moduleUrl = `file://${encodeURI(process.cwd())}/lib/http-dispatcher.ts`;
  const { configureHttpDispatcher } = await importRuntimeModule(moduleUrl);
  await configureHttpDispatcher();
}
