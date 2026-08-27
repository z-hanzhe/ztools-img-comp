'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { collectRuntimePackages, ROOT } = require('./release-deps');

const NOTICE_NAMES = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md',
  'COPYING', 'COPYING.md', 'NOTICE', 'NOTICE.md', 'NOTICE.txt'
];

/**
 * 读取包根目录及 codec 目录中的许可证文件。
 * @param {string} packageRoot 包目录
 * @returns {Array<{name:string, content:string}>} 许可证内容
 */
function readLicenseFiles(packageRoot, packageJson) {
  const candidates = [];
  for (const name of NOTICE_NAMES) candidates.push(path.join(packageRoot, name));
  const codecDir = path.join(packageRoot, 'codec');
  if (fs.existsSync(codecDir)) {
    for (const entry of fs.readdirSync(codecDir)) {
      if (/^(license|copying|notice)/i.test(entry)) candidates.push(path.join(codecDir, entry));
    }
  }
  const seen = new Set();
  const result = [];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const key = content.replace(/\s+/g, ' ');
    if (!content || seen.has(key)) continue;
    seen.add(key);
    result.push({ name: path.relative(packageRoot, filePath).replace(/\\/g, '/'), content });
  }
  if (result.length === 0) {
    const declaredLicense = packageJson.license || '未声明';
    const fallback = {
      'boolbase@1.0.0': 'Copyright (c) 2014-2015, Felix Boehm <me@feedic.com>\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.'
    };
    const fallbackKey = `${packageJson.name}@${packageJson.version}`;
    result.push({
      name: `package.json license metadata (${declaredLicense})`,
      content: fallback[fallbackKey] || `This package declares the ${declaredLicense} license in package.json. No standalone license file was included in the published package.`
    });
  }
  return result;
}

/**
 * 生成随发行包分发的第三方许可证清单。
 */
function main() {
  const packages = collectRuntimePackages();
  const sections = [
    '# Third-Party Notices',
    '',
    'img-comp bundles the following runtime dependencies. Each dependency remains under its own license.',
    ''
  ];

  for (const item of packages) {
    const licenseFiles = readLicenseFiles(item.root, item.packageJson);
    if (licenseFiles.length === 0) {
      throw new Error(`依赖缺少可读取的许可证文件: ${item.name}@${item.packageJson.version}`);
    }
    sections.push(`## ${item.name}@${item.packageJson.version}`);
    sections.push('');
    sections.push(`Declared license: ${item.packageJson.license || '未声明'}`);
    if (item.packageJson.repository) {
      const repository = typeof item.packageJson.repository === 'string'
        ? item.packageJson.repository
        : item.packageJson.repository.url;
      if (repository) sections.push(`Repository: ${repository}`);
    }
    sections.push('');
    for (const license of licenseFiles) {
      sections.push(`### ${license.name}`);
      sections.push('');
      sections.push('```text');
      sections.push(license.content);
      sections.push('```');
      sections.push('');
    }
  }

  const output = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');
  fs.writeFileSync(output, sections.join('\n') + '\n', 'utf8');
  console.log(`[notices] ${packages.length} 个运行时包 -> ${output}`);
}

main();
