import { constants } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const newline = String.fromCharCode(10);
let output: string | undefined;
let created = false;
try {
  const { values, tokens } = parseArgs({ strict: true, allowPositionals: false, tokens: true, options: {
    'out-dir': { type: 'string' }, 'assets-dir': { type: 'string' },
  } });
  if (!values['out-dir'] || tokens.length !== new Set(tokens.map((token) => token.kind === 'option' ? token.name : '')).size) throw new Error('Invalid arguments');
  const requested = resolve(values['out-dir']);
  output = join(await realpath(dirname(requested)), basename(requested));
  const build = await realpath(join(root, 'dist'));
  const source = join(build, 'src');
  if (!(await lstat(join(source, 'cli/start.js'))).isFile()) throw new Error('Build first');
  const assets = values['assets-dir'] ? await realpath(values['assets-dir']) : undefined;
  const contains = (parent: string, child: string) => { const path = relative(parent, child); return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)); };
  if (contains(build, output) || contains(output, build) || contains(join(root, 'examples'), output) || contains(join(root, 'docs'), output) || (assets && (contains(assets, output) || contains(output, assets)))) throw new Error('Overlapping directories');
  if (assets && (!(await lstat(assets)).isDirectory() || !(await lstat(join(assets, 'index.html'))).isFile())) throw new Error('Missing external build');
  await mkdir(output); created = true;
  await cp(source, join(output, 'dist/src'), { recursive: true, dereference: false, errorOnExist: true, force: false });
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown> & { scripts: Record<string, string>; version: string };
  metadata.scripts = Object.fromEntries(['start', 'config:migrate', 'consumer:recover'].map((name) => [name, metadata.scripts[name]!]));
  await writeFile(join(output, 'package.json'), JSON.stringify(metadata, null, 2) + newline);
  await copyFile(join(root, 'package-lock.json'), join(output, 'package-lock.json'), constants.COPYFILE_EXCL);
  await copyFile(join(root, '.node-version'), join(output, '.node-version'), constants.COPYFILE_EXCL);
  await cp(join(root, 'docs'), join(output, 'docs'), { recursive: true });
  await cp(join(root, 'examples'), join(output, 'examples'), { recursive: true });
  await cp(join(build, 'examples'), join(output, 'dist/examples'), { recursive: true });
  const entries: { path: string; bytes: number; gzip_bytes: number; brotli_bytes: number; sha256: string }[] = [];
  const copyAssets = async (directory: string, target: string): Promise<void> => {
    await mkdir(target);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name), destination = join(target, entry.name);
      if (entry.isDirectory()) { await copyAssets(path, destination); continue; }
      if (!entry.isFile()) throw new Error('Assets must be regular files');
      if (entries.length >= 10000 || (await lstat(path)).size > 64 * 1024 * 1024) throw new Error('Asset limits exceeded');
      const bytes = await readFile(path);
      await writeFile(destination, bytes, { flag: 'wx' });
      entries.push({ path: relative(assets!, path).split(sep).join('/'), bytes: bytes.length, gzip_bytes: gzipSync(bytes, { level: 9 }).length, brotli_bytes: brotliCompressSync(bytes).length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  };
  if (assets) await copyAssets(assets, join(output, 'admin'));
  const totals = entries.reduce((sum, file) => ({ bytes: sum.bytes + file.bytes, gzip_bytes: sum.gzip_bytes + file.gzip_bytes, brotli_bytes: sum.brotli_bytes + file.brotli_bytes }), { bytes: 0, gzip_bytes: 0, brotli_bytes: 0 });
  await writeFile(join(output, 'bundle.json'), JSON.stringify({ format: 1, version: metadata.version, assets: assets ? { files: entries.length, ...totals, entries } : null }, null, 2) + newline);
  process.stdout.write(JSON.stringify({ event: 'package_created', directory: output, assets_dir: assets ? join(output, 'admin') : null, assets: { files: entries.length, ...totals } }) + newline);
} catch {
  if (created && output) await rm(output, { recursive: true, force: true });
  process.stderr.write('package_failed: build first, use a new output directory, and provide a regular external static build with index.html.' + newline);
  process.exitCode = 1;
}
