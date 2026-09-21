import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "tests/realtime.test.ts"],
  { stdio: "inherit", env: { ...process.env, RUN_REALTIME: "1" } },
);
process.exit(result.status ?? 1);
