'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const options = new Map([
  ['configuration', 'Configuration'], ['sdk-root', 'SdkRoot'],
  ['java-home', 'JavaHome'], ['application-id', 'ApplicationId'],
  ['app-label', 'AppLabel'], ['build-dir', 'BuildDir'],
  ['output-apk', 'OutputApk'], ['signing-directory', 'SigningDirectory'],
  ['key-alias', 'KeyAlias'],
]);
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('Build the Android development APK on Windows. SDK: ANDROID_SDK_ROOT or ANDROID_HOME; JDK: JAVA_HOME.');
  console.log('Options: ' + [...options.keys(), 'powershell'].map(name => `--${name} <value>`).join(', '));
  console.log('Release requires explicit --application-id, --signing-directory and --key-alias. See docs/ANDROID-BUILD.md.');
  process.exit(0);
}
if (process.platform !== 'win32') {
  console.error('This Android build entry currently supports Windows PowerShell 5.1 and PowerShell 7 on Windows.');
  process.exit(1);
}
const parameters = [];
const seen = new Set();
let powershell = 'powershell.exe';
for (let i = 0; i < argv.length; i++) {
  const name = argv[i].startsWith('--') ? argv[i].slice(2) : '';
  if ((!options.has(name) && name !== 'powershell') || seen.has(name) || i + 1 === argv.length || argv[i + 1].startsWith('--')) {
    console.error(`Unknown, repeated or incomplete option: ${argv[i]}. Use --help.`);
    process.exit(1);
  }
  seen.add(name);
  const value = argv[++i];
  if (name === 'powershell') powershell = value;
  else parameters.push('-' + options.get(name), value);
}
const root = path.resolve(__dirname, '..');
// A Windows PowerShell child must not inherit PowerShell 7's module search path
// (or vice versa). Let the selected host initialize its own standard modules.
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (name.toLowerCase() === 'psmodulepath') delete environment[name];
}
const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'android', 'build.ps1'), ...parameters], {
  cwd: root, env: environment, stdio: 'inherit', windowsHide: true, shell: false,
});
if (result.error) console.error('Could not start PowerShell: ' + result.error.message);
process.exit(result.status ?? 1);
