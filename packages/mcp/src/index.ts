#!/usr/bin/env node

import { startStdioServer } from "./server.js";

startStdioServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`moemodels-mcp: ${message}\n`);
  process.exitCode = 1;
});
