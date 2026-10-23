'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function abortCheck(signal) {
  if (signal?.aborted) throw Object.assign(new Error('已取消保存'), { name: 'AbortError' });
}
async function snapshot(file) {
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('目标不是普通文件，请选择其他保存位置。');
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function sameSnapshot(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function verify(file, expectedSize, expectedSha256, signal, progress) {
  const digest = crypto.createHash('sha256'); let size = 0;
  for await (const bytes of fs.createReadStream(file, { highWaterMark: 65536 })) {
    abortCheck(signal); size += bytes.length;
    if (size > expectedSize) throw new Error('保存文件的大小超出预期。');
    digest.update(bytes); progress?.(size);
  }
  abortCheck(signal);
  if (size !== expectedSize || digest.digest('hex') !== expectedSha256) throw new Error('保存后完整性校验失败，文件内容与原件不一致。');
}

/** Writes only to a native-dialog path or a user-chosen receive folder. Never trusts renderer paths. */
async function saveVerifiedFile({ url, destination, expectedSize, expectedSha256, signal, onProgress = () => {}, idleTimeoutMs = 180000, overwrite = true, fetcher = fetch }) {
  if (!path.isAbsolute(destination) || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 20 * 1024 ** 3
      || typeof expectedSha256 !== 'string' || expectedSha256.length !== 64 || !/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error('保存文件的大小或校验记录无效。');
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw new Error('下载超时设置无效。');
  expectedSha256 = expectedSha256.toLowerCase(); abortCheck(signal);
  const checkAbsent = async () => {
    try { await fsp.lstat(destination); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw Object.assign(new Error('目标位置已有文件或目录，请使用其他文件名。'), { code: 'EEXIST' });
  };
  if (!overwrite) await checkAbsent();
  const before = overwrite ? await snapshot(destination) : null;
  const directory = path.dirname(destination), id = crypto.randomUUID();
  const temporary = path.join(directory, '.relaydrop-' + id + '.part');
  const backup = path.join(directory, '.relaydrop-' + id + '.backup');
  let handle, movedOriginal = false, published = false, publishedIdentity = null, completed = false;
  const idle = new AbortController();
  const downloadSignal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  let idleTimer;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(Object.assign(new Error('下载连接长时间没有响应，已停止保存，请重试。'), { code: 'ETIMEDOUT' })), idleTimeoutMs);
    idleTimer.unref?.();
  };
  let lastEvent = 0;
  const progress = (status, transferred, force = false) => {
    if (force || Date.now() - lastEvent > 100) { lastEvent = Date.now(); onProgress({ status, transferred, total: expectedSize }); }
  };
  try {
    touch();
    const response = await fetcher(url, { signal: downloadSignal, redirect: 'error', headers: { 'Accept-Encoding': 'identity' } });
    touch();
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel(); throw new Error('文件不可下载，下载凭证可能已过期，请重试。');
    }
    const length = response.headers.get('content-length'), etag = response.headers.get('etag');
    if (!length || !/^\d+$/.test(length) || Number(length) !== expectedSize || etag?.toLowerCase() !== '"' + expectedSha256 + '"') {
      await response.body.cancel(); throw new Error('下载的大小或 SHA-256 与中转站记录不一致，已拒绝保存。');
    }
    abortCheck(signal); handle = await fsp.open(temporary, 'wx', 0o600);
    const digest = crypto.createHash('sha256'); let total = 0;
    progress('saving', 0, true);
    for await (const data of response.body) {
      touch(); abortCheck(downloadSignal); const bytes = Buffer.from(data); total += bytes.length;
      if (total > expectedSize) throw new Error('收到的内容超出声明大小，已停止保存。');
      digest.update(bytes); let offset = 0;
      while (offset < bytes.length) {
        abortCheck(downloadSignal); const result = await handle.write(bytes, offset, bytes.length - offset);
        if (!result.bytesWritten) throw new Error('无法继续写入目标文件。'); offset += result.bytesWritten;
      }
      progress('saving', total);
    }
    clearTimeout(idleTimer); abortCheck(downloadSignal);
    if (total !== expectedSize || digest.digest('hex') !== expectedSha256) throw new Error('下载内容不完整或 SHA-256 不匹配，未替换目标文件。');
    await handle.sync(); await handle.close(); handle = null;
    progress('verifying', 0, true);
    await verify(temporary, expectedSize, expectedSha256, signal, n => progress('verifying', n));
    if (!overwrite) await checkAbsent();
    else if (!sameSnapshot(before, await snapshot(destination))) throw new Error('保存期间目标文件已被其他程序修改，请重新选择位置。');
    abortCheck(signal);
    if (before) { await fsp.rename(destination, backup); movedOriginal = true; }
    try {
      // NTFS supports atomic publication without replacing another file. Other
      // filesystems still use an exclusive destination so a concurrent file is safe.
      try { await fsp.link(temporary, destination); published = true; }
      catch (error) {
        if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EINVAL'].includes(error.code)) throw error;
        await fsp.copyFile(temporary, destination, fs.constants.COPYFILE_EXCL); published = true;
      }
      publishedIdentity = await snapshot(destination);
      // Re-open the final path as well, before the old copy can be removed.
      progress('verifying', 0, true);
      await verify(destination, expectedSize, expectedSha256, signal, n => progress('verifying', n));
      completed = true;
    } catch (error) { throw error; }
    if (movedOriginal) { await fsp.unlink(backup).catch(() => {}); movedOriginal = false; }
    progress('completed', expectedSize, true);
    return { size: expectedSize, sha256: expectedSha256, path: destination };
  } catch (error) {
    if (idle.signal.aborted && !signal?.aborted) error = idle.signal.reason;
    if (handle) { await handle.close().catch(() => {}); handle = null; }
    if (published && !completed) {
      const current = await snapshot(destination).catch(() => null);
      if (!publishedIdentity || (current && current.dev === publishedIdentity.dev && current.ino === publishedIdentity.ino)) await fsp.unlink(destination).catch(() => {});
    }
    if (movedOriginal) {
      try {
        if (await snapshot(destination)) throw new Error('目标位置已出现新文件');
        await fsp.rename(backup, destination); movedOriginal = false;
      } catch {
        error = new Error((error.message || '保存失败') + '\n原文件仍保留在：' + backup);
      }
    }
    throw error;
  } finally {
    clearTimeout(idleTimer);
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
  }
}
module.exports = { saveVerifiedFile, verify, snapshot };
