'use strict';
const path = require('node:path');
const buildIdentity = require('./build-identity.cjs');

module.exports = function configuration({ projectDir, outputDir, electronDist, version, release = false }) {
  const identity = buildIdentity({ relaydropChannel: release ? 'release' : 'development' });
  return {
    appId: identity.appId,
    productName: identity.productName,
    copyright: 'RelayDrop contributors',
    electronVersion: '45.0.0',
    electronDist,
    electronLanguages: ['zh-CN', 'en-US'],
    directories: { output: outputDir, buildResources: path.join(projectDir, 'desktop/assets') },
    extraMetadata: { name: identity.packageName, version, main: 'desktop/main.cjs', relaydropChannel: identity.channel, author: { name: 'RelayDrop contributors' } },
    asar: true,
    npmRebuild: false,
    forceCodeSigning: false,
    publish: null,
    files: [
      'package.json', 'server.cjs', 'security.cjs', 'vendor/**/*', 'file-pool.cjs',
      'pool-storage.cjs', 'encrypted-backup.cjs', 'shared-folders.cjs', 'discovery.cjs', 'bluetooth.cjs',
      'public/**/*', 'remote/*.cjs', 'RelayDrop-Android.apk',
      'desktop/*.cjs', '!desktop/electron-builder.cjs',
      'desktop/ui/**/*', 'desktop/assets/icon.png', 'desktop/assets/icon.ico',
      'LICENSE', 'QR-LICENSE.txt', 'THIRD_PARTY_NOTICES.md', 'LICENSES/**/*',
    ],
    win: {
      target: [{ target: 'portable', arch: ['x64'] }, { target: 'nsis', arch: ['x64'] }],
      icon: path.join(projectDir, 'desktop/assets/icon.ico'),
      executableName: identity.executableName,
      signExecutable: false,
    },
    nsis: {
      artifactName: identity.artifactPrefix + '-Setup-${version}-${arch}.${ext}',
      oneClick: true,
      perMachine: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: identity.productName,
      runAfterFinish: false,
      deleteAppDataOnUninstall: false,
      include: path.join(projectDir, 'desktop/installer.nsh'),
    },
    portable: {
      artifactName: identity.artifactPrefix + '-Desktop-${version}-${arch}.${ext}',
      requestExecutionLevel: 'user',
      // A fresh extraction directory avoids simultaneous launches removing
      // each other's files when the second launch only restores the tray app.
      unpackDirName: true,
    },
  };
};
