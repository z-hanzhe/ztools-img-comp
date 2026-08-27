'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { compressByName } = require('./compression-engine');

const WORKSPACE = path.join(os.tmpdir(), 'ztools.image.compression');
const HISTORY_KEY = 'history-v3';
const HISTORY_LIMIT = 8;
const STALE_AFTER = 24 * 60 * 60 * 1000;
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.svg']);

/**
 * 创建唯一的批次标识。
 * @param {string} prefix 标识前缀
 * @returns {string} 唯一标识
 */
function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 确保工作目录存在，并清理过期的临时结果。
 * @returns {Promise<void>} 完成信号
 */
async function prepareWorkspace() {
  await fsp.mkdir(WORKSPACE, { recursive: true });
  const cutoff = Date.now() - STALE_AFTER;
  let names = [];
  try { names = await fsp.readdir(WORKSPACE); } catch { return; }
  await Promise.all(names.map(async name => {
    const candidate = path.join(WORKSPACE, name);
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        await fsp.rm(candidate, { recursive: true, force: true });
      }
    } catch {}
  }));
}

/**
 * 将 Data URI 转成文件内容。
 * @param {string} value 图片 Data URI
 * @returns {{extension:string, bytes:Buffer}} 图片扩展名和字节
 */
function decodeDataUri(value) {
  const match = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i.exec(value || '');
  if (!match) throw new Error('图片数据格式无效');
  const subtype = match[1].toLowerCase();
  const extension = `.${subtype === 'jpeg' ? 'jpg' : subtype === 'svg+xml' ? 'svg' : subtype}`;
  return { extension, bytes: Buffer.from(match[2], 'base64') };
}

/**
 * 将相对输出路径清理为安全的 POSIX 风格路径。
 * @param {unknown} value 原始路径
 * @param {string} fallback 备用文件名
 * @returns {string} 安全的相对路径
 */
function safeRelativeName(value, fallback) {
  const source = String(value || fallback || 'image');
  const parts = source
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .map(part => part.replace(/[<>:"|?*\u0000-\u001f]/g, '_'));
  return parts.length > 0 ? parts.join('/') : (fallback || 'image');
}

/**
 * 为批次中的每个输入项分配不冲突的输出路径。
 * @param {Array<object>} entries 输入项
 */
function assignOutputNames(entries) {
  const used = new Set();
  for (const entry of entries) {
    const fallback = path.basename(entry.filename || 'image');
    const original = safeRelativeName(entry.relativeName, fallback);
    let candidate = original;
    let key = candidate.toLowerCase();
    if (used.has(key)) {
      const parent = safeRelativeName(path.basename(path.dirname(entry.inputPath)), 'images');
      candidate = safeRelativeName(`${parent}/${fallback}`, fallback);
      key = candidate.toLowerCase();
    }
    if (used.has(key)) {
      const extension = path.extname(fallback);
      const stem = path.basename(fallback, extension);
      const parent = path.posix.dirname(candidate);
      let suffix = 2;
      do {
        const name = `${stem} (${suffix++})${extension}`;
        candidate = parent === '.' ? name : `${parent}/${name}`;
        key = candidate.toLowerCase();
      } while (used.has(key));
    }
    used.add(key);
    entry.outputName = candidate;
  }
}

/**
 * 清理历史记录中已经失效的临时结果路径。
 * @param {object} entry 历史输入项
 * @returns {object} 可展示输入项
 */
function restoreEntry(entry) {
  const restored = { ...entry };
  if (restored.resultPath && !fs.existsSync(restored.resultPath)) {
    restored.resultPath = null;
    restored.resultBytes = restored.inputBytes;
    restored.savedPercent = 0;
  }
  restored.relativeName = safeRelativeName(restored.relativeName, restored.filename);
  return restored;
}

/**
 * 规范化历史记录顺序和数量。
 * @param {unknown} value 原始记录
 * @returns {Array<object>} 规范化记录
 */
function normaliseHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && typeof item === 'object')
    .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
    .slice(-HISTORY_LIMIT);
}

/**
 * 读取持久化历史记录。
 * @returns {Array<object>} 历史记录
 */
function readHistory() {
  try {
    const storage = globalThis.window?.ztools?.dbStorage;
    if (!storage) return [];
    const raw = storage.getItem(HISTORY_KEY);
    return raw ? normaliseHistory(JSON.parse(raw)) : [];
  } catch (error) {
    console.error('[img-comp] 读取历史记录失败:', error);
    return [];
  }
}

/**
 * 写入持久化历史记录。
 * @param {Array<object>} records 历史记录
 * @returns {boolean} 是否写入成功
 */
function writeHistory(records) {
  try {
    const storage = globalThis.window?.ztools?.dbStorage;
    if (!storage) return false;
    storage.setItem(HISTORY_KEY, JSON.stringify(normaliseHistory(records)));
    return true;
  } catch (error) {
    console.error('[img-comp] 写入历史记录失败:', error);
    return false;
  }
}

/**
 * 删除一条历史记录。
 * @param {string} id 记录标识
 * @returns {boolean} 是否写入成功
 */
function removeHistory(id) {
  return writeHistory(readHistory().filter(item => item.id !== id));
}

/**
 * 清空历史记录。
 * @returns {boolean} 是否写入成功
 */
function clearHistory() {
  try {
    const storage = globalThis.window?.ztools?.dbStorage;
    if (!storage) return false;
    storage.removeItem(HISTORY_KEY);
    storage.removeItem('history');
    return true;
  } catch { return false; }
}

/**
 * 读取路径的文件名和大小。
 * @param {string} filePath 文件路径
 * @param {string} fallbackName 备用文件名
 * @returns {Promise<object|null>} 输入项
 */
async function inspectFile(filePath, fallbackName) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return null;
    const filename = fallbackName || path.basename(filePath);
    if (!SUPPORTED_EXTENSIONS.has(path.extname(filename).toLowerCase())) return null;
    return {
      id: makeId('entry'),
      inputPath: path.resolve(filePath),
      inputBytes: stat.size,
      filename,
      relativeName: filename,
      outputName: filename,
      resultPath: null,
      resultBytes: null,
      savedPercent: null,
      error: null
    };
  } catch { return null; }
}

/**
 * 递归收集目录中的图片。
 * @param {string} basePath 根目录
 * @returns {Promise<Array<object>>} 输入项
 */
async function collectDirectory(basePath) {
  const result = [];
  async function visit(currentPath) {
    let entries;
    try { entries = await fsp.readdir(currentPath, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name.endsWith('.asar')) continue;
        await visit(fullPath);
      } else if (entry.isFile()) {
        const item = await inspectFile(fullPath);
        if (item) item.relativeName = path.relative(basePath, fullPath) || item.filename;
        if (item) result.push(item);
      }
    }
  }
  await visit(basePath);
  return result;
}

/**
 * 创建空批次对象。
 * @param {string} kind 批次来源类型
 * @returns {object} 批次
 */
function createBatchState(kind) {
  return {
    id: makeId('batch'),
    kind,
    createdAt: Date.now(),
    phase: 'pending',
    cancelled: false,
    rootPath: null,
    outputRoot: null,
    entries: [],
    progress: { total: 0, completed: 0, succeeded: 0, failed: 0, percent: 0 }
  };
}

/**
 * 将剪贴板图片写入批次工作目录。
 * @param {object} batch 批次
 * @param {string[]} dataUris 图片数据
 * @returns {Promise<void>} 完成信号
 */
async function attachDataUris(batch, dataUris) {
  if (!Array.isArray(dataUris) || dataUris.length === 0) return;
  const inputRoot = path.join(WORKSPACE, 'clipboard', batch.id);
  await fsp.mkdir(inputRoot, { recursive: true });
  for (let index = 0; index < dataUris.length; index++) {
    const decoded = decodeDataUri(dataUris[index]);
    const filename = `clipboard-${index + 1}${decoded.extension}`;
    const inputPath = path.join(inputRoot, filename);
    await fsp.writeFile(inputPath, decoded.bytes);
    batch.entries.push({
      id: makeId('entry'),
      inputPath,
      inputBytes: decoded.bytes.length,
      filename,
      relativeName: filename,
      outputName: filename,
      resultPath: null,
      resultBytes: null,
      savedPercent: null,
      error: null
    });
  }
}

/**
 * 根据 ZTools 输入创建一个批次。
 * @param {{kind:string,payload?:unknown}} request 输入请求
 * @returns {Promise<object>} 批次
 */
async function createBatch(request = {}) {
  await prepareWorkspace();
  const batch = createBatchState(request.kind || 'files');
  if (request.kind === 'clipboard') {
    await attachDataUris(batch, Array.isArray(request.payload) ? request.payload : [request.payload]);
  } else {
    const descriptors = Array.isArray(request.payload) ? request.payload : [];
    const directories = descriptors.filter(item => item && item.isDirectory && item.path);
    const files = descriptors.filter(item => item && item.isFile && item.path);
    for (const descriptor of directories) {
      const root = path.resolve(descriptor.path);
      const entries = await collectDirectory(root);
      if (!batch.rootPath && directories.length === 1) batch.rootPath = root;
      batch.entries.push(...entries);
    }
    for (const descriptor of files) {
      const item = await inspectFile(descriptor.path, descriptor.name);
      if (item) batch.entries.push(item);
    }
  }
  assignOutputNames(batch.entries);
  batch.progress.total = batch.entries.length;
  return batch;
}

/**
 * 向已有批次追加剪贴板图片。
 * @param {object} batch 批次
 * @param {string[]} dataUris 图片数据
 * @returns {Promise<object>} 更新后的批次
 */
async function addDataUris(batch, dataUris) {
  await attachDataUris(batch, dataUris);
  assignOutputNames(batch.entries);
  batch.progress.total = batch.entries.length;
  return batch;
}

/**
 * 生成当前批次的输出路径。
 * @param {object} batch 批次
 * @param {object} entry 输入项
 * @returns {string} 输出路径
 */
function resultPathFor(batch, entry) {
  if (!batch.outputRoot) batch.outputRoot = path.join(WORKSPACE, 'results', batch.id);
  return path.join(batch.outputRoot, entry.outputName || entry.relativeName || entry.filename);
}

/**
 * 执行批次中的所有图片。
 * @param {object} batch 批次
 * @param {(batch:object)=>void} onChange 状态回调
 * @returns {Promise<object>} 完成后的批次
 */
async function executeBatch(batch, onChange) {
  if (!batch || !Array.isArray(batch.entries)) throw new Error('批次数据无效');
  batch.phase = 'running';
  emitChange(batch, onChange);
  for (const entry of batch.entries) {
    if (batch.cancelled) break;
    try {
      if (!entry.inputBytes) throw new Error('文件内容为空');
      const original = await fsp.readFile(entry.inputPath);
      const compressed = await compressByName(entry.filename, original);
      if (compressed.length >= original.length) {
        entry.resultPath = entry.inputPath;
        entry.resultBytes = original.length;
        entry.savedPercent = 0;
      } else {
        entry.resultPath = resultPathFor(batch, entry);
        entry.resultBytes = compressed.length;
        entry.savedPercent = Number((100 * (1 - compressed.length / original.length)).toFixed(1));
        await fsp.mkdir(path.dirname(entry.resultPath), { recursive: true });
        await fsp.writeFile(entry.resultPath, compressed);
      }
      batch.progress.succeeded += 1;
    } catch (error) {
      entry.error = error && error.message ? error.message : '处理失败';
      batch.progress.failed += 1;
    }
    batch.progress.completed += 1;
    batch.progress.percent = batch.progress.total
      ? Math.round(batch.progress.completed * 100 / batch.progress.total)
      : 100;
    emitChange(batch, onChange);
  }
  if (batch.cancelled) {
    for (const entry of batch.entries) {
      if (!entry.resultPath && !entry.error) entry.error = '已取消';
    }
    batch.phase = 'cancelled';
  } else {
    batch.phase = 'complete';
  }
  emitChange(batch, onChange);
  return batch;
}

/**
 * 安全触发状态回调。
 * @param {object} batch 批次
 * @param {(batch:object)=>void} callback 回调
 */
function emitChange(batch, callback) {
  if (typeof callback === 'function') callback(batch);
}

/**
 * 取消批次。
 * @param {object} batch 批次
 * @returns {object} 更新后的批次
 */
function cancelBatch(batch) {
  if (batch) batch.cancelled = true;
  return batch;
}

/**
 * 将结果覆盖回输入文件。
 * @param {object} batch 已完成批次
 * @returns {Promise<boolean>} 是否全部成功
 */
async function replaceInputs(batch) {
  if (!batch || batch.phase !== 'complete') return false;
  let success = true;
  for (const entry of batch.entries) {
    if (!entry.resultPath || entry.resultPath === entry.inputPath || entry.error) continue;
    try {
      await fsp.copyFile(entry.resultPath, entry.inputPath);
    } catch (error) {
      success = false;
      console.error('[img-comp] 覆盖原文件失败:', entry.inputPath, error);
    }
  }
  return success;
}

/**
 * 复制单个路径到系统剪贴板。
 * @param {string} filePath 文件路径
 * @returns {boolean} 是否成功
 */
function copyPath(filePath) {
  try { return !!globalThis.window?.ztools?.copyFile(filePath); } catch { return false; }
}

/**
 * 一次性复制多个路径，并校验系统剪贴板收到的数量。
 * @param {string[]} paths 文件路径列表
 * @returns {Promise<object>} 复制结果
 */
async function copyPaths(paths) {
  const list = [...new Set((Array.isArray(paths) ? paths : [])
    .filter(value => typeof value === 'string' && fs.existsSync(value))
    .map(value => path.resolve(value)))];
  if (list.length === 0) return { success: false, count: 0, expected: 0 };
  const host = globalThis.window?.ztools;
  try {
    if (host && typeof host.copyFile === 'function') {
      if (!host.copyFile(list)) return { success: false, count: 0, expected: list.length };
      if (process.platform === 'win32' && typeof host.getCopyedFiles === 'function') {
        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt) await new Promise(resolve => setTimeout(resolve, 30));
          const current = host.getCopyedFiles();
          const currentPaths = new Set((Array.isArray(current) ? current : [])
            .map(item => typeof item === 'string' ? item : item?.path)
            .filter(Boolean)
            .map(value => path.resolve(value).toLowerCase()));
          const count = list.filter(value => currentPaths.has(value.toLowerCase())).length;
          if (count === list.length) return { success: true, count, expected: list.length };
        }
        return { success: false, count: 0, expected: list.length };
      }
      return { success: true, count: list.length, expected: list.length };
    }
    const result = await host?.clipboard?.writeContent?.({ type: 'file', content: list }, false);
    return { success: !!result?.success, count: result?.success ? list.length : 0, expected: list.length };
  } catch (error) {
    console.error('[img-comp] 复制文件失败:', error);
    return { success: false, count: 0, expected: list.length };
  }
}

/**
 * 将批次转换为可持久化的摘要。
 * @param {object} batch 批次
 * @returns {object} 历史记录
 */
function toHistoryRecord(batch) {
  return {
    id: batch.id,
    kind: batch.kind,
    createdAt: batch.createdAt,
    count: batch.entries.length,
    rootPath: batch.rootPath || null,
    entries: batch.entries.map(entry => ({
      inputPath: entry.inputPath,
      inputBytes: entry.inputBytes,
      filename: entry.filename,
      relativeName: entry.relativeName,
      outputName: entry.outputName,
      resultPath: entry.resultPath,
      resultBytes: entry.resultBytes,
      savedPercent: entry.savedPercent,
      error: entry.error || null
    }))
  };
}

/**
 * 从历史摘要恢复可展示批次。
 * @param {object} record 历史记录
 * @returns {object} 批次
 */
function fromHistoryRecord(record) {
  const entries = Array.isArray(record?.entries)
    ? record.entries.map(restoreEntry)
    : [];
  assignOutputNames(entries);
  return {
    id: record.id,
    historyId: record.id,
    kind: record.kind || 'files',
    createdAt: record.createdAt || Date.now(),
    phase: 'complete',
    cancelled: false,
    rootPath: record.rootPath || null,
    outputRoot: null,
    entries,
    progress: {
      total: entries.length,
      completed: entries.length,
      succeeded: entries.filter(entry => !entry.error).length,
      failed: entries.filter(entry => entry.error).length,
      percent: 100
    },
    historical: true
  };
}

/**
 * 格式化文件大小。
 * @param {number} bytes 字节数
 * @returns {string} 展示文本
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

module.exports = {
  addDataUris,
  cancelBatch,
  clearHistory,
  copyPath,
  copyPaths,
  createBatch,
  executeBatch,
  formatBytes,
  fromHistoryRecord,
  readHistory,
  removeHistory,
  replaceInputs,
  toHistoryRecord,
  writeHistory
};
