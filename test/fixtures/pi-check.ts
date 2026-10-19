#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

if (process.argv[2] === '--version') {
  process.stdout.write('1.3.0\n');
} else {
  process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
  writeFileSync(process.env.PI_CHECK_FIXTURE_PATH!, JSON.stringify({ pid: process.pid, directory: process.env.PI_CODING_AGENT_DIR }));
  setInterval(() => {}, 1000);
}
