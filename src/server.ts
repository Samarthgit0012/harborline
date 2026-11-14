import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { log } from "./log.js";
import { describeMode, startupWarnings } from "./ops/startup.js";

const config = loadConfig();
const server = createApp(config).listen(config.port, () => {
  console.log(`Harborline IVR listening on :${config.port}`);
  for (const line of describeMode(config)) console.log(`  ${line}`);
  for (const w of startupWarnings(config)) console.log(`  !! ${w}`);
});

// A crash must be visible and must never be silent. (Phase 10 adds a supervisor that restarts us.)
process.on("unhandledRejection", (reason) => log("error", "unhandled_rejection", { reason: String(reason) }));
process.on("uncaughtException", (err) => {
  log("error", "uncaught_exception", { error: err.message });
  process.exit(1);
});

/** On a stop request, finish the calls in flight, then exit. A host that redeploys sends SIGTERM first. */
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log("info", "shutting_down", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref(); // do not hang forever on a stuck connection
  });
}
