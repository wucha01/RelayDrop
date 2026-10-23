'use strict';

// Missing metadata deliberately selects a separate developer installation.
// Only scripts/build-desktop.cjs --release opts into the existing release ID.
module.exports = function buildIdentity(metadata = {}) {
  const release = metadata.relaydropChannel === 'release';
  return Object.freeze({
    channel: release ? 'release' : 'development',
    packageName: release ? 'relaydrop' : 'relaydrop-development',
    productName: release ? 'RelayDrop' : 'RelayDrop Development',
    executableName: release ? 'RelayDrop' : 'RelayDropDevelopment',
    appId: release ? 'app.relaydrop.desktop' : 'app.relaydrop.desktop.development',
    dataDirectoryName: release ? 'RelayDropDesktop' : 'RelayDropDesktopDevelopment',
    artifactPrefix: release ? 'RelayDrop' : 'RelayDrop-Development',
  });
};
