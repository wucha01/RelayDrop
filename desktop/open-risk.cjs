'use strict';
const path = require('node:path');
const risky = new Set(['.exe','.com','.scr','.bat','.cmd','.ps1','.psm1','.psd1','.ps1xml','.ps2','.vbs','.vbe','.vb','.js','.jse','.wsf','.wsh','.sct','.hta','.lnk','.url','.scf','.pif','.reg','.inf','.cpl','.msc','.msi','.msp','.msix','.msixbundle','.appx','.appxbundle','.application','.appref-ms','.jar','.py','.pyw','.rb','.pl','.sh','.bash','.command','.desktop','.chm','.hlp','.docm','.dotm','.xlsm','.xltm','.xlam','.xlsb','.pptm','.potm','.ppam','.ppsm','.sldm']);
function requiresConfirmation(filename) { return risky.has(path.extname(String(filename).replace(/[. ]+$/g,'')).toLowerCase()); }
async function confirmOpen(dialog, window, filename) {
  if (!requiresConfirmation(filename)) return true;
  const result = await dialog.showMessageBox(window, { type: 'warning', title: '确认打开可执行文件', message: '「' + path.basename(filename) + '」可能运行程序、脚本或快捷方式。', detail: '完整性校验只能确认副本与原件一致，不能证明文件安全。只打开来源可信且你明确需要运行的文件。', buttons: ['取消', '确认打开'], defaultId: 0, cancelId: 0, noLink: true });
  return result.response === 1;
}
module.exports = { requiresConfirmation, confirmOpen };
