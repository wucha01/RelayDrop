'use strict';
const path = require('node:path');
const MAX_PREVIEW_SOURCE = 32 * 1024 * 1024;
const MAX_PDF_SOURCE = 128 * 1024 * 1024;
const MAX_VIDEO_SOURCE = 512 * 1024 * 1024;
const MAX_PREVIEW_PIXELS = 40_000_000;
const MAX_PREVIEW_BYTES = 300 * 1024;
const MAX_DETAIL_BYTES = 1024 * 1024;
const MAX_TEXT_SOURCE = 256 * 1024;
const GROUPS = {
  image: ['jpg','jpeg','png','webp','gif','bmp','heic','heif','avif','tif','tiff','svg','ico'],
  text: ['txt','md','markdown','log','csv','tsv','json','xml','yaml','yml','ini','conf'],
  document: ['pdf','doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','rtf','epub'],
  video: ['mp4','mkv','mov','avi','webm','m4v','3gp','mpeg','mpg','wmv','ts'],
  audio: ['mp3','wav','m4a','aac','flac','ogg','opus','wma','aiff'],
  archive: ['zip','7z','rar','tar','gz','bz2','xz','tgz','zst'],
};
const extension = name => path.extname(String(name || '').replace(/\\/g, '/')).slice(1).toLowerCase();
function category(name) { const ext = extension(name); return Object.keys(GROUPS).find(group => GROUPS[group].includes(ext)) || 'other'; }
function previewKind(file) {
  if (!Number.isSafeInteger(file.size) || file.size < 0) return null;
  const ext = extension(file.name);
  if (category(file.name) === 'text' && file.size <= MAX_TEXT_SOURCE) return 'text';
  if (file.size < 1) return null;
  if (['jpg','jpeg','png','webp'].includes(ext) && file.size <= MAX_PREVIEW_SOURCE) return 'image';
  if (ext === 'pdf' && file.size <= MAX_PDF_SOURCE) return 'pdf';
  if (['mp4','webm','mov','m4v','3gp'].includes(ext) && file.size <= MAX_VIDEO_SOURCE) return 'video';
  return null;
}
function mediaType(file) {
  if (!Number.isSafeInteger(file.size) || file.size < 1) return null;
  return ({ mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime', m4v:'video/mp4', '3gp':'video/3gpp', mp3:'audio/mpeg', wav:'audio/wav', m4a:'audio/mp4', aac:'audio/aac', flac:'audio/flac', ogg:'audio/ogg', opus:'audio/ogg' })[extension(file.name)] || null;
}
function previewable(file) { return ['image','pdf','video'].includes(previewKind(file)); }
function view(file, enabled = true) {
  const kind = previewKind(file), effective = kind === 'text' || enabled ? kind : null;
  return { ...file, folderId: file.folderId || null, category: category(file.name), previewable: !!enabled && previewable(file), previewKind: effective, mediaType: mediaType(file) };
}
function decodeText(bytes) {
  if (bytes.length > MAX_TEXT_SOURCE) throw new Error('TEXT_TOO_LARGE');
  let encoding = 'utf-8';
  if (bytes[0] === 255 && bytes[1] === 254) encoding = 'utf-16le';
  if (bytes[0] === 254 && bytes[1] === 255) encoding = 'utf-16be';
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (text.includes('\0') || Buffer.byteLength(text) > MAX_TEXT_SOURCE * 3) throw new Error('TEXT_ENCODING_UNSUPPORTED');
  return text;
}
function imageDimensions(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217 || marker === undefined) return null;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (length < 8) return null;
        return { format: 'jpeg', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  if (bytes.length >= 30 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), at = offset + 8;
      if (length < 1 || at + length > bytes.length) return null;
      if (kind === 'VP8X' && length >= 10) return (bytes[at] & 2) ? null : { format: 'webp', width: bytes.readUIntLE(at + 4, 3) + 1, height: bytes.readUIntLE(at + 7, 3) + 1 };
      if (kind === 'VP8 ' && length >= 10 && bytes.subarray(at + 3, at + 6).equals(Buffer.from([157,1,42]))) return { format:'webp', width: bytes.readUInt16LE(at + 6) & 0x3fff, height: bytes.readUInt16LE(at + 8) & 0x3fff };
      if (kind === 'VP8L' && length >= 5 && bytes[at] === 47) { const bits = bytes.readUInt32LE(at + 1); return { format: 'webp', width: (bits & 0x3fff) + 1, height: (bits >>> 14 & 0x3fff) + 1 }; }
      offset = at + length + (length & 1);
    }
  }
  return null;
}
function safeDimensions(info, maximum = MAX_PREVIEW_PIXELS) { return !!info && Number.isInteger(info.width) && Number.isInteger(info.height) && info.width > 0 && info.height > 0 && info.width * info.height <= maximum; }
module.exports = { GROUPS, category, previewable, previewKind, mediaType, view, decodeText, imageDimensions, safeDimensions, MAX_TEXT_SOURCE, MAX_PREVIEW_SOURCE, MAX_PDF_SOURCE, MAX_VIDEO_SOURCE, MAX_PREVIEW_BYTES, MAX_DETAIL_BYTES, MAX_PREVIEW_PIXELS };
