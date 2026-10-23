'use strict';

// Read-only source hygiene check. Findings deliberately omit matched values.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const strict = process.argv.includes('--strict-clean');
const findings = [];
const skipped = [];
const files = [];
const reviewedDirectories = new Set();
const reviewedPaths = new Set(['.']);
const add = (file, rule, line) => findings.push({
  file: reviewedPaths.has(file) || reviewedDirectories.has(file) || buildDirectories.has(file)
    ? file : `<unreviewed:${crypto.createHash('sha256').update(file).digest('hex').slice(0, 12)}>`,
  rule, ...(line ? { line } : {}),
});
const buildDirectories = new Set(['node_modules', '.build', 'dist', '.git', 'coverage']);
const binaryExtensions = new Set(['.png', '.ico', '.jar', '.ttf', '.pfb']);
const manifestPath = 'scripts/source-files.json';

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') &&
    !value.startsWith('/') && !value.includes(':') &&
    value.split('/').every(part => part && part !== '.' && part !== '..');
}

function walk(directory, relative = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(directory, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) { add(rel, 'symbolic-link-or-junction'); continue; }
    if (stat.isDirectory()) {
      if (!relative && buildDirectories.has(entry.name)) {
        if (strict) add(rel, 'generated-directory-in-clean-source');
        else skipped.push(rel);
      } else if (!reviewedDirectories.has(rel)) add(rel, 'unreviewed-directory');
      else walk(full, rel);
    } else if (stat.isFile()) {
      files.push(rel);
      if (stat.nlink > 1) add(rel, 'hard-linked-file');
    } else add(rel, 'non-regular-file');
  }
}

function checkPattern(rel, text, rule, regex, allow) {
  regex.lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    if (allow?.(match)) continue;
    add(rel, rule, text.slice(0, match.index).split('\n').length);
  }
}

function inspectText(rel, text) {
  const fixture = /^test\/[^/]+\.test\.cjs$/.test(rel);
  const upstream = rel.startsWith('vendor/') || rel === 'QR-LICENSE.txt' || rel === 'android/lib/LICENSE-nanohttpd.md';
  checkPattern(rel, text, 'private-key-material', /-----BEGIN (?:[A-Z ]*)PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{32,}/g);
  checkPattern(rel, text, 'service-access-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g);
  checkPattern(rel, text, 'personal-home-path', /(?:[A-Za-z]:[\\/]+Users[\\/]+[^\s"'<>]+|\/Users\/[^\s"'<>]+|\/home\/[a-z_][a-z0-9_.-]*\/)/g);
  if (!upstream && !fixture) {
    checkPattern(rel, text, 'literal-long-credential', /\b(?:hostToken|deviceToken|apiKey|accessToken|secret|password)\s*["']?\s*[:=]\s*["'][A-Za-z0-9/+_=.-]{20,}["']/g);
    checkPattern(rel, text, 'literal-machine-path', /\b[A-Z]:[\\/]+[A-Za-z0-9_\u3400-\u9fff][^\s"'<>]*/g, match => {
      const normalized = match[0].replace(/\\+/g, '/');
      if (rel === 'bluetooth.cjs' && normalized === ['C:', 'Windows'].join('/')) return true;
      // Generic documentation examples, reviewed individually; no user homes.
      const examples = [
        ['C:', 'Android', 'Sdk'], ['C:', 'Java', 'jdk'], ['C:', 'Java', 'jdk-17'],
        ['C:', 'PrivateKeys', 'RelayDrop'],
      ].map(parts => parts.join('/'));
      return ['README.md', 'docs/ANDROID-BUILD.md'].includes(rel) && examples.includes(normalized);
    });
    checkPattern(rel, text, 'private-network-literal', /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g, match => {
      // These exact Android hint fields are illustrative, never stored endpoints.
      const hintFiles = ['android/src/app/relaydrop/MainActivity.java', 'android/src/app/relaydrop/ShareActivity.java'];
      return hintFiles.includes(rel) && match[0] === ['192', '168', '1', '10'].join('.') &&
        text.slice(Math.max(0, match.index - 24), match.index).endsWith('.setHint("https://') &&
        text.slice(match.index + match[0].length).startsWith(':8765");');
    });
    checkPattern(rel, text, 'literal-device-address', /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g);
    checkPattern(rel, text, 'embedded-url-credential', /https?:\/\/[^\s"'<>/@:]+:[^\s"'<>/@]+@/g);
    checkPattern(rel, text, 'literal-account-email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, match => {
      // Upstream glob's npm deprecation message includes its public maintainer contact.
      return rel === 'package-lock.json' && match[0] === ['i', 'izs.me'].join('@') &&
        text.slice(text.lastIndexOf('\n', match.index) + 1, match.index).trimStart().startsWith('"deprecated":');
    });
  }
}

function inspectPng(rel, bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    add(rel, 'invalid-png'); return;
  }
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    if (size > bytes.length - offset - 12) { add(rel, 'invalid-png-chunk'); return; }
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) add(rel, 'image-personal-or-time-metadata');
    offset += size + 12;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || offset !== bytes.length) add(rel, 'invalid-or-trailed-png');
}

function inspectIco(rel, bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
    add(rel, 'invalid-icon'); return;
  }
  const count = bytes.readUInt16LE(4);
  if (!count || bytes.length < 6 + count * 16) { add(rel, 'invalid-icon-directory'); return; }
  for (let i = 0; i < count; i++) {
    const start = 6 + i * 16;
    const length = bytes.readUInt32LE(start + 8);
    const offset = bytes.readUInt32LE(start + 12);
    if (offset < 6 + count * 16 || length > bytes.length - offset) { add(rel, 'invalid-icon-image'); continue; }
    const image = bytes.subarray(offset, offset + length);
    if (image[0] === 137 && image[1] === 80) inspectPng(rel, image);
    else if (image.length < 40 || image.readUInt32LE(0) !== 40) add(rel, 'unreviewed-icon-format');
  }
}

function inspectWindowsMetadata() {
  if (process.platform !== 'win32') return 'not-applicable';
  const script = [
    "$ErrorActionPreference='Stop'",
    '$inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$matches=@()',
    'foreach($relative in $inputData.files) {',
    '  $itemPath=Join-Path $inputData.root $relative',
    '  $streams=@(Get-Item -LiteralPath $itemPath -Stream * -ErrorAction Stop)',
    '  if(@($streams | Where-Object { $_.Stream -ne \':$DATA\' }).Count -gt 0) { $matches += $relative }',
    '}',
    'ConvertTo-Json -InputObject @($matches) -Compress',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify({ root, files }), encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  if (result.status !== 0) { add('.', 'cannot-inspect-windows-alternate-streams'); return 'failed'; }
  try {
    for (const rel of JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())) add(rel, 'windows-alternate-data-stream');
    return 'checked';
  } catch { add('.', 'cannot-read-windows-metadata-result'); return 'failed'; }
}

function main() {
  const unknown = process.argv.slice(2).filter(arg => arg !== '--strict-clean');
  if (unknown.length) throw Error('unsupported-arguments');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.every(safeRelative) ||
      new Set(manifest.files).size !== manifest.files.length) throw Error('invalid-source-manifest');
  const expected = new Set([...manifest.files, manifestPath]);
  const pinned = manifest.reviewedSha256 || {};
  if (Object.entries(pinned).some(([rel, hash]) => !expected.has(rel) || !/^[a-f0-9]{64}$/.test(hash))) throw Error('invalid-resource-manifest');
  for (const rel of expected) {
    reviewedPaths.add(rel);
    const segments = rel.split('/');
    for (let i = 1; i < segments.length; i++) reviewedDirectories.add(segments.slice(0, i).join('/'));
  }
  walk(root);
  const actual = new Set(files);
  for (const rel of expected) if (!actual.has(rel)) add(rel, 'missing-reviewed-source-file');
  for (const rel of files) {
    if (!expected.has(rel)) { add(rel, 'unreviewed-file'); continue; }
    const full = path.join(root, rel);
    const bytes = fs.readFileSync(full);
    const extension = path.extname(rel).toLowerCase();
    const binary = binaryExtensions.has(extension);
    if (binary && !pinned[rel]) add(rel, 'unreviewed-binary');
    // Git normalizes text line endings; binary hashes remain byte-for-byte.
    const hashInput = binary ? bytes : Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
    if (pinned[rel] && crypto.createHash('sha256').update(hashInput).digest('hex') !== pinned[rel]) add(rel, 'reviewed-resource-hash-mismatch');
    if (!binary) {
      if (bytes.includes(0)) add(rel, 'unexpected-binary-content');
      inspectText(rel, bytes.toString('utf8'));
    }
    if (extension === '.png') inspectPng(rel, bytes);
    if (extension === '.ico') inspectIco(rel, bytes);
    if (extension === '.pem') {
      if (rel !== 'android/res/raw/webview_trust_anchor.pem') add(rel, 'unreviewed-certificate');
      try { new crypto.X509Certificate(bytes); } catch { add(rel, 'invalid-public-certificate'); }
    }
  }
  const windowsAlternateStreams = inspectWindowsMetadata();
  const report = {
    passed: findings.length === 0, strictClean: strict, checkedFiles: files.length,
    pinnedResources: Object.keys(pinned).length, windowsAlternateStreams,
    skippedGeneratedDirectories: skipped, findings,
    limits: 'Heuristic source review; fixtures and preserved upstream attributions are intentional. No matched values or filesystem owner/timestamps are emitted.',
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = findings.length ? 1 : 0;
}

try { main(); }
catch {
  // Do not print exception messages: they may contain local absolute paths.
  process.stdout.write(JSON.stringify({ passed: false, findings: [{ file: '.', rule: 'audit-could-not-complete' }] }, null, 2) + '\n');
  process.exitCode = 1;
}
