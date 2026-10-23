'use strict';
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..'), target = path.join(root, 'vendor');
function packageRoot(name, from = root) {
  let dir = path.dirname(require.resolve(name, { paths: [from] }));
  while (true) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) return dir;
    const parent = path.dirname(dir); if (parent === dir) throw new Error('Cannot locate package: ' + name); dir = parent;
  }
}
async function main() {
  fs.mkdirSync(target, {recursive:true});
  await require('esbuild').build({entryPoints:[path.join(__dirname,'x509-entry.cjs')],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:path.join(target,'x509.cjs'),minify:true,legalComments:'eof'});
  const licenses = [], seen = new Set();
  function licensePackage(dir) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
    if (seen.has(pkg.name)) return; seen.add(pkg.name);
    const file = ['LICENSE','LICENSE.md','LICENSE.txt','License.txt'].map(n=>path.join(dir,n)).find(f=>fs.existsSync(f));
    if (!file) throw new Error('Missing dependency license: ' + pkg.name);
    licenses.push('## '+pkg.name+' '+pkg.version+'\n'+fs.readFileSync(file,'utf8'));
    for (const dep of Object.keys(pkg.dependencies||{})) licensePackage(packageRoot(dep, dir));
  }
  for (const dep of ['@peculiar/x509','reflect-metadata']) licensePackage(packageRoot(dep));
  const pdf = packageRoot('pdfjs-dist');
  for (const file of ['pdf.mjs','pdf.worker.mjs']) fs.copyFileSync(path.join(pdf,'legacy/build',file),path.join(target,file));
  fs.cpSync(path.join(pdf,'standard_fonts'),path.join(target,'standard_fonts'),{recursive:true});
  const version = name => JSON.parse(fs.readFileSync(path.join(packageRoot(name),'package.json'),'utf8')).version;
  licenses.push('## pdfjs-dist '+version('pdfjs-dist')+'\n'+fs.readFileSync(path.join(pdf,'LICENSE'),'utf8'));
  fs.writeFileSync(path.join(target,'THIRD-PARTY-LICENSES.txt'),licenses.join('\n\n'));
  fs.writeFileSync(path.join(target,'versions.json'),JSON.stringify({x509:version('@peculiar/x509'),pdfjs:version('pdfjs-dist'),esbuild:version('esbuild')},null,2)+'\n');
  console.log('Rebuilt local X509/PDF.js assets and retained dependency licenses.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
