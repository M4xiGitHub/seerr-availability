// Reuse the pinned upstream frontend/dependencies; compile only the changed backend.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('/tooling/node_modules/typescript');
for (const file of ['index.ts', 'lib/releaseAvailability.ts']) {
  const out = path.join('/app/dist', file.replace(/\.ts$/, '.js'));
  let source = ts.transpileModule(fs.readFileSync(path.join('/source/server', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: file,
  }).outputText;
  source = source.replace(/require\(["']@server\/([^"']+)["']\)/g, (_, name) => {
    let relative = path.relative(path.dirname(out), path.join('/app/dist', name));
    if (!relative.startsWith('.')) relative = './' + relative;
    return `require(${JSON.stringify(relative)})`;
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, source);
}
