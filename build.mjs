import { build }                       from 'esbuild';
import { copyFileSync, existsSync,
         mkdirSync, readdirSync,
         renameSync, unlinkSync }       from 'node:fs';
import { join, resolve }               from 'node:path';
import { fileURLToPath }               from 'node:url';
import { execSync }                    from 'node:child_process';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const platform  = process.platform;
const arch      = process.arch;
const pkgPath   = join(__dirname, 'node_modules/@duckdb', `node-bindings-${platform}-${arch}`);

if (!existsSync(pkgPath)) {
  console.error(`ERROR: DuckDB bindings not found: ${pkgPath}`);
  process.exit(1);
}

mkdirSync('dist', { recursive: true });

const duckdbPlugin = {
  name: 'duckdb-local',
  setup(build) {
    build.onResolve({ filter: /node-bindings/ }, args => ({
      path: args.path,
      namespace: 'duckdb-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'duckdb-stub' }, () => ({
      contents: `module.exports = require('./duckdb.node')`,
      loader: 'js',
    }));
  }
};

await build({
  entryPoints: ['src/mcp.js'],
  bundle:      true,
  platform:    'node',
  format:      'esm',
  outfile:     'dist/mcp.js',
  external:    ['*.node'],
  minify:      true,
  plugins:     [duckdbPlugin],
  banner:      { js: `import{createRequire}from'node:module';const require=createRequire(import.meta.url);` }
});

console.log('  esbuild: dist/mcp.js OK');

copyFileSync(join(__dirname, 'schema.default.yaml'), join('dist', 'schema.default.yaml'));
console.log('  copied:  dist/schema.default.yaml');

const files = readdirSync(pkgPath).filter(f =>
  f.endsWith('.node') || f.endsWith('.dll') || f.endsWith('.so') || f.endsWith('.dylib')
);

for (const file of files) {
  copyFileSync(join(pkgPath, file), join('dist', file));
  console.log(`  copied:  dist/${file}`);
}

console.log('Build OK');

if (process.argv.includes('--mcpb')) {
  mkdirSync('mcpb', { recursive: true });
  const out = join(__dirname, 'mcpb', 'mcp-memory-graphdb.mcpb');
  if (existsSync(out)) unlinkSync(out);

  if (platform === 'win32') {
    const tmp = join(__dirname, 'mcpb', 'mcp-memory-graphdb.zip');
    if (existsSync(tmp)) unlinkSync(tmp);
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Force ` +
      `-Path '${join(__dirname, 'dist')}','${join(__dirname, 'manifest.json')}' ` +
      `-DestinationPath '${tmp}'"`,
      { stdio: 'inherit' }
    );
    renameSync(tmp, out);
  } else {
    execSync(`cd "${__dirname}" && zip -r "${out}" dist/ manifest.json`, { stdio: 'inherit' });
  }

  console.log(`  packed:  mcpb/mcp-memory-graphdb.mcpb`);
}
