#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { evaluateProviderParity, hashParityPolicy } from './src/provider-parity.mjs';

async function readJson(path) {
  if (!path || (await stat(path)).size > 32 * 1024 * 1024) throw new Error('invalid_file');
  return JSON.parse(await readFile(path, 'utf8'));
}
try {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--policy-hash') {
    console.log(hashParityPolicy(await readJson(args[1])));
  } else if (args.length === 4 && args[0] === '--policy' && args[2] === '--evidence') {
    const report = evaluateProviderParity(await readJson(args[1]), await readJson(args[3]));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'offline_screen_passed' ? 0 : 2;
  } else {
    console.error('Usage: node scripts/check-provider-parity.mjs --policy POLICY.json --evidence EVIDENCE.json\n       node scripts/check-provider-parity.mjs --policy-hash POLICY.json');
    process.exitCode = 2;
  }
} catch {
  // Never echo evidence, source content, credentials or filesystem error paths.
  console.error('Provider comparison unavailable: provide valid, bounded JSON policy and evidence files.');
  process.exitCode = 2;
}
