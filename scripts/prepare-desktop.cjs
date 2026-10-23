'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function prepareDesktop(root = path.resolve(__dirname, '..')) {
  if (process.platform !== 'win32') throw new Error('The supported desktop workflow must run on Windows.');
  const dependenciesDir = path.join(root, 'node_modules');
  const electronDist = path.join(dependenciesDir, 'electron/dist');
  const packageJSON = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  let electronMetadata;
  try { electronMetadata = JSON.parse(fs.readFileSync(path.join(dependenciesDir, 'electron/package.json'), 'utf8')); }
  catch { throw new Error('The pinned Electron dependency is missing. Run npm ci first.'); }
  if (electronMetadata.version !== packageJSON.devDependencies.electron) throw new Error('Electron version differs from the pinned dependency. Run npm ci.');
  function installed() {
    const versionFile = path.join(electronDist, 'version');
    return fs.existsSync(path.join(electronDist, 'electron.exe')) && fs.existsSync(versionFile)
      && fs.readFileSync(versionFile, 'utf8').trim().replace(/^v/, '') === electronMetadata.version;
  }
  if (!installed()) {
    // Electron 45 exposes an explicit installer instead of a postinstall hook.
    // Its package contains the distribution checksums verified by install.js.
    console.log('Installing the pinned Electron runtime using its official installer...');
    const install = spawnSync(process.execPath, [path.join(dependenciesDir, 'electron/install.js')], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (install.error || install.status !== 0 || !installed()) throw new Error('Electron runtime installation failed. Check network access and retry.');
  }
  return electronDist;
}

module.exports = { prepareDesktop };
if (require.main === module) {
  try { prepareDesktop(); console.log('Pinned Electron runtime is ready.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
