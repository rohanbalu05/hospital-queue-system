// Bundles the worker and the workspace TypeScript packages (@hqms/*) into dist/main.js.
// Native/CJS runtime dependencies stay external and are resolved from node_modules at start.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['pg', 'pg-native', '@node-rs/argon2'],
  // Some bundled CJS dependencies call require(); give them one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
