'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareDesktop } = require('./prepare-desktop.cjs');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const relativePath = file => path.relative(root, file).split(path.sep).join('/');

async function main() {
  const buildScripts = new Map([__filename, path.join(__dirname, 'prepare-desktop.cjs')].map(file => [file, hash(fs.readFileSync(file))]));
  let release = false, directoryOnly = false, androidApk;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--release') release = true;
    else if (args[i] === '--dir') directoryOnly = true;
    else if (args[i] === '--android-apk' && args[i + 1] && !args[i + 1].startsWith('--')) androidApk = path.resolve(args[++i]);
    else throw new Error('Usage: node scripts/build-desktop.cjs [--dir] [--release] [--android-apk path/to/app.apk]');
  }
  if (process.platform !== 'win32') throw new Error('The supported Windows packaging workflow must run on Windows.');
  const packageJSON = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const identity = require('../desktop/build-identity.cjs')({ relaydropChannel: release ? 'release' : 'development' });
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(packageJSON.version)) throw new Error('package.json must contain a valid application version.');
  const dependenciesDir = path.join(root, 'node_modules');
  const electronDist = prepareDesktop(root);
  const buildRoot = path.join(root, '.build');
  const outputDir = path.join(root, 'dist', 'windows-' + identity.channel);
  fs.mkdirSync(buildRoot, { recursive: true });
  const projectDir = fs.mkdtempSync(path.join(buildRoot, 'desktop-stage-'));
  const snapshot = new Map(), sourceLocations = new Map();
  const buildOnly = new Set(['desktop/electron-builder.cjs', 'desktop/installer.nsh']);
  // The allowlist excludes runtime pools, credentials, signing material,
  // test results, and developer caches from the application snapshot.
  const selected = [
    'package.json', 'server.cjs', 'security.cjs', 'file-pool.cjs', 'shared-folders.cjs',
    'pool-storage.cjs', 'encrypted-backup.cjs', 'discovery.cjs', 'bluetooth.cjs',
    'public', 'vendor', 'LICENSE', 'QR-LICENSE.txt',
    ...fs.readdirSync(path.join(root, 'remote')).filter(file => file.endsWith('.cjs')).map(file => 'remote/' + file),
    ...fs.readdirSync(path.join(root, 'desktop')).filter(file => file.endsWith('.cjs')).map(file => 'desktop/' + file),
    'desktop/ui', 'desktop/installer.nsh', 'desktop/assets/icon.png', 'desktop/assets/icon.ico',
    ...['THIRD_PARTY_NOTICES.md', 'LICENSES'].filter(file => fs.existsSync(path.join(root, file))),
  ];
  function copy(file, source = path.join(root, file)) {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error('Build inputs must not be symbolic links: ' + file);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(source)) copy(file + '/' + child, path.join(source, child));
      return;
    }
    if (!stat.isFile()) throw new Error('Unexpected build input: ' + file);
    const bytes = fs.readFileSync(source), target = path.join(projectDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    snapshot.set(file, hash(bytes)); sourceLocations.set(file, source);
  }
  selected.forEach(file => copy(file));
  if (androidApk) {
    if (path.extname(androidApk).toLowerCase() !== '.apk') throw new Error('--android-apk must name an APK file.');
    copy('RelayDrop-Android.apk', androidApk);
  }
  function verifyInputs() {
    for (const [file, expected] of snapshot) {
      if (hash(fs.readFileSync(sourceLocations.get(file))) !== expected || hash(fs.readFileSync(path.join(projectDir, file))) !== expected) {
        throw new Error('Build source changed during packaging; run the build again: ' + file);
      }
    }
    for (const [file, expected] of buildScripts) if (hash(fs.readFileSync(file)) !== expected) throw new Error('Build script changed during packaging: ' + relativePath(file));
  }
  verifyInputs();
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  process.env.ELECTRON_BUILDER_CACHE = path.join(buildRoot, 'electron-builder-cache');
  const { build, Platform, Arch } = require(path.join(dependenciesDir, 'electron-builder'));
  const config = require(path.join(projectDir, 'desktop/electron-builder.cjs'))({ projectDir, outputDir, electronDist, version: packageJSON.version, release });
  const targets = Platform.WINDOWS.createTarget(directoryOnly ? ['dir'] : ['portable', 'nsis'], Arch.x64);
  const results = await build({ projectDir, targets, config, publish: 'never' });
  verifyInputs();
  const asar = require(path.join(dependenciesDir, '@electron/asar'));
  const archive = path.join(outputDir, 'win-unpacked/resources/app.asar');
  for (const [file, expected] of snapshot) {
    if (file === 'package.json' || buildOnly.has(file)) continue;
    if (hash(asar.extractFile(archive, path.normalize(file))) !== expected) throw new Error('Packaged resource SHA-256 mismatch: ' + file);
  }
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (packaged.version !== packageJSON.version || packaged.main !== 'desktop/main.cjs' || packaged.relaydropChannel !== identity.channel || packaged.name !== identity.packageName) {
    throw new Error('Unexpected packaged application identity.');
  }
  const required = new Map([
    [identity.artifactPrefix + '-Desktop-' + packageJSON.version + '-x64.exe', 'portable'],
    [identity.artifactPrefix + '-Setup-' + packageJSON.version + '-x64.exe', 'installer'],
  ]);
  const installers = [...new Set(results.filter(file => file.toLowerCase().endsWith('.exe')))];
  if (!directoryOnly && (installers.length !== 2 || installers.some(file => !required.has(path.basename(file))))) throw new Error('Expected one portable EXE and one setup EXE.');
  const artifacts = (directoryOnly ? [path.join(outputDir, 'win-unpacked', identity.executableName + '.exe')] : installers).map(file => ({
    kind: directoryOnly ? 'unpacked' : required.get(path.basename(file)),
    path: relativePath(file), bytes: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)),
  }));
  const report = {
    complete: true, version: packageJSON.version, channel: identity.channel,
    appId: identity.appId, dataDirectoryName: identity.dataDirectoryName,
    windowsCodeSigning: false, automaticPublishing: false,
    snapshot: relativePath(projectDir), archive: relativePath(archive),
    immutableSnapshot: Object.fromEntries(snapshot),
    bundledApk: androidApk ? { sha256: snapshot.get('RelayDrop-Android.apk') } : null,
    artifacts,
    buildScript: { path: relativePath(__filename), sha256: buildScripts.get(__filename) },
    buildScripts: Object.fromEntries([...buildScripts].map(([file, sha256]) => [relativePath(file), sha256])),
  };
  fs.writeFileSync(path.join(outputDir, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ complete: true, channel: identity.channel, artifacts, report: relativePath(path.join(outputDir, 'build-report.json')) }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
