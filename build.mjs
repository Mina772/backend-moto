import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Never carry a removed entry point into a later deployment or zip.
await rm(fileURLToPath(new URL('./dist/', import.meta.url)), { recursive: true, force: true });

// Bundle app + workspace packages; keep third-party deps external (resolved from node_modules at runtime).
const workspaceOnly = {
  name: 'workspace-only',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@moto/') ? undefined : { path: args.path, external: true }));
  },
};

const result = await build({
  entryPoints: ['src/server.ts', 'src/db/init-admin.ts', 'src/db/reset-data.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'dist',
  sourcemap: true,
  metafile: true,
  plugins: [workspaceOnly],
  logLevel: 'info',
});

if (Object.keys(result.metafile.inputs).some((input) => /(^|[\\/])(test|fixtures|seed)[\\/]/.test(input))) {
  throw new Error('Deployment bundle must not contain test fixtures or seed generators');
}
