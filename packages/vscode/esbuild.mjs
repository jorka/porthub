import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const minify = process.argv.includes('--minify');
const watch = process.argv.includes('--watch');

const common = { bundle: true, platform: 'node', target: 'node18', format: 'cjs', minify, sourcemap: !minify, logLevel: 'info' };

const configs = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
mkdirSync('dist', { recursive: true });
cpSync('../../README.md', 'README.md');
cpSync('../../LICENSE', 'LICENSE');
cpSync('../../CHANGELOG.md', 'CHANGELOG.md');
