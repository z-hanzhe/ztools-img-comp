// 构建脚本：生成许可证清单，筛选运行时依赖，打包为 ZTools 可安装的 .zpx
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const asar = require('@electron/asar');
const { collectRuntimePackages, ROOT } = require('./release-deps');

const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, '_stage');
const ASAR = path.join(DIST, 'img-comp.asar');
const ZPX = path.join(DIST, 'img-comp.zpx');
const SOURCE_FILES = [
  'plugin.json',
  'index.html',
  'index.css',
  'index.js',
  'preload.js',
  'runtime-service.js',
  'compression-engine.js',
  'assets/logo.png',
  'package.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md'
];
const OMIT_DIRS = new Set([
  '.git', '.github', '.circleci', 'test', 'tests', 'demo', 'examples',
  '__tests__', 'coverage', 'benchmark', 'benchmarks'
]);

/**
 * 复制发布包中的文件树，并过滤测试、源码映射和开发元数据。
 * @param {string} source 源路径
 * @param {string} target 目标路径
 */
function copyRuntimeTree(source, target) {
  const stat = fs.statSync(source);
  const base = path.basename(source);
  if (stat.isDirectory()) {
    if (OMIT_DIRS.has(base)) return;
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRuntimeTree(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  if (!stat.isFile()) return;
  if (/\.(map|ts|d\.ts)$/i.test(base)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

/**
 * 清理并创建构建暂存目录。
 */
function resetDirectories() {
  fs.mkdirSync(DIST, { recursive: true });
  for (const file of [ASAR, ZPX]) {
    try { fs.unlinkSync(file); } catch {}
  }
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
}

/**
 * 把插件源文件复制到暂存目录。
 */
function stageSourceFiles() {
  for (const relativePath of SOURCE_FILES) {
    const source = path.join(ROOT, relativePath);
    if (!fs.existsSync(source)) throw new Error(`缺少发布文件: ${relativePath}`);
    copyRuntimeTree(source, path.join(STAGE, relativePath));
  }
}

/**
 * 把运行时依赖闭包复制到暂存目录。
 */
function stageRuntimeDependencies() {
  for (const item of collectRuntimePackages()) {
    const relativeRoot = path.relative(ROOT, item.root);
    copyRuntimeTree(item.root, path.join(STAGE, relativeRoot));
  }
}

/**
 * 构建并压缩 ZTools 插件包。
 */
async function main() {
  cp.execFileSync(process.execPath, [path.join(ROOT, 'generate-notices.js')], { stdio: 'inherit' });
  resetDirectories();
  stageSourceFiles();
  stageRuntimeDependencies();

  console.log('[build] asar pack ->', ASAR);
  await asar.createPackage(STAGE, ASAR);

  console.log('[build] gzip ->', ZPX);
  const archive = await fsp.readFile(ASAR);
  await fsp.writeFile(ZPX, zlib.gzipSync(archive, { level: 9 }));
  fs.rmSync(STAGE, { recursive: true, force: true });

  for (const file of [ASAR, ZPX]) {
    const size = fs.statSync(file).size;
    console.log('  ', file, '-', (size / 1024 / 1024).toFixed(2), 'MB');
  }
  console.log('[build] OK');
}

main().catch(error => {
  console.error('BUILD FAILED:', error);
  try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
