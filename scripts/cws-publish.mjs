#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'EXTENSION_ID', 'PUBLISHER_ID'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Missing env: ${missing.join(', ')}`);
}

const distDir = path.join(root, 'dist');
const zips = fs.readdirSync(distDir)
  .filter((name) => name.startsWith('1p3a-helper-') && name.endsWith('.zip'))
  .sort();
if (!zips.length) {
  throw new Error('No dist/1p3a-helper-*.zip. Run `make publish` first.');
}
const zipPath = path.join(distDir, zips.at(-1));
const extensionId = process.env.EXTENSION_ID;

function run(args) {
  const result = spawnSync('npx', ['--yes', 'chrome-webstore-upload-cli@4', ...args], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`chrome-webstore-upload-cli ${args[0]} failed with status ${result.status}`);
  }
}

console.log(`Uploading ${zipPath}`);
run(['upload', '--source', zipPath, '--extension-id', extensionId]);
console.log('Submitting for review');
run(['publish', '--extension-id', extensionId]);
