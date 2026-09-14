#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const distDir = path.join(root, 'dist');
const zipName = `1p3a-helper-${manifest.version}.zip`;
const zipPath = path.join(distDir, zipName);

const entries = [
  'manifest.json',
  'src',
  'data/answer-bank.json',
  'assets/1point3acres-helper-icon-16.png',
  'assets/1point3acres-helper-icon-32.png',
  'assets/1point3acres-helper-icon-48.png',
  'assets/1point3acres-helper-icon-128.png',
  'assets/1point3acres-helper-icon-enabled-16.png',
  'assets/1point3acres-helper-icon-enabled-32.png',
  'assets/1point3acres-helper-icon-enabled-48.png',
  'assets/1point3acres-helper-icon-enabled-128.png',
];

for (const relative of entries) {
  if (!fs.existsSync(path.join(root, relative))) {
    throw new Error(`Missing package entry: ${relative}`);
  }
}

fs.mkdirSync(distDir, { recursive: true });
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

const packed = spawnSync('zip', ['-r', zipPath, ...entries, '-x', '*.DS_Store'], {
  cwd: root,
  stdio: 'inherit',
});
if (packed.status !== 0) {
  throw new Error(`zip failed with status ${packed.status}`);
}

const listed = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
if (listed.status !== 0) {
  throw new Error('unzip -l failed');
}
const names = listed.stdout.split('\n').map((line) => line.trim().split(/\s+/).pop() || '');
if (!names.includes('manifest.json')) {
  throw new Error('zip root must contain manifest.json');
}
if (names.some((name) => name.startsWith('.git/') || name === 'scripts/' || name === 'docs/')) {
  throw new Error('zip contains excluded paths');
}

console.log(`Wrote ${zipPath}`);
console.log(listed.stdout);
