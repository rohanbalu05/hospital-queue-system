import { readFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';

/**
 * db/seed/seed.ts ends with a "run as a CLI" block keyed on `import.meta.url === argv[1]`. Inside a
 * bundle that condition is true for `node dist/main.js`, which would seed on every boot. The plugin
 * switches the block off; SEED_ON_START calls `seed()` explicitly instead.
 */
const seedWithoutCli = {
  name: 'seed-without-cli',
  setup(build: {
    onLoad: (
      opts: { filter: RegExp },
      cb: (args: { path: string }) => Promise<{ contents: string; loader: 'ts' }>,
    ) => void;
  }) {
    build.onLoad({ filter: /db[\\/]seed[\\/]seed\.ts$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const patched = source.replace(
        /if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\)/,
        'if (false)',
      );
      if (patched === source) throw new Error('seed.ts CLI guard not found: update apps/api/tsup.config.ts');
      return { contents: patched, loader: 'ts' };
    });
  },
};

/**
 * Bundle the API plus the workspace TypeScript packages (D-010) into one ESM file. Third-party
 * packages stay external (installed in node_modules). Decorators need no emitted metadata because
 * every injection is explicit (`@Inject(TOKEN)`), so plain esbuild is enough.
 */
export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@hqms\//],
  esbuildPlugins: [seedWithoutCli],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
