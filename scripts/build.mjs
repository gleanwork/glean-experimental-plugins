// Build the plugin's MCP server into a single-file ESM bundle.
//
// Why bundle: Cowork's plugin-install validator rejects zip entries whose
// paths contain `@`, which appears in every scoped npm package's directory
// name (`node_modules/@modelcontextprotocol/...`). Inlining every dep into
// one `dist/index.js` means the shipped tree has no scoped-package paths.
//
// Bundle shape:
//   - platform=node, format=esm so Node can load it with `node dist/index.js`
//     and no `--experimental-*` flags, matching our package.json type:module
//   - bundle=true with packages='bundled' so every import except Node
//     builtins gets inlined
//   - external: the `node:*` builtins (explicit for clarity; esbuild on
//     platform=node treats bare `node:*` as external by default but we pin
//     it so this doesn't regress silently)
//   - no sourcemap or minification — the bundle is checked into git and
//     should stay readable for debugging

import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { builtinModules } from "node:module";

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

await build({
  entryPoints: ["src/index.ts"],
  outfile: "plugins/glean/dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Not setting `packages` — esbuild only accepts `"external"` here, which
  // would ship every dep as a runtime lookup (defeating the purpose). The
  // default when `bundle:true` is to inline every import whose specifier
  // isn't in `external`, which is exactly what we want.
  external: nodeBuiltins,
  // Some transitive deps (e.g. `yaml`) ship CJS that does `require("node:*")`
  // at module-eval time. esbuild inlines that CJS under an ESM shim that
  // does NOT provide a `require`, so imports blow up with "Dynamic require
  // of X is not supported". Prepending a `createRequire`-based shim gives
  // the inlined CJS a working `require` for Node builtins.
  banner: {
    js: `import { createRequire as __glean_createRequire } from "node:module";\nconst require = __glean_createRequire(import.meta.url);`,
  },
  minify: false,
  legalComments: "linked",
  logLevel: "info",
  // The SDK and some transitive deps still ship CJS under their "require"
  // export condition. We're emitting ESM and asking esbuild to resolve
  // through each package's "import" condition first.
  conditions: ["import", "node", "default"],
  mainFields: ["module", "main"],
});

// Mirror the bundle into the codex package dist/ directory. Codex copies
// plugins into a cache dir that doesn't preserve symlinks, so it needs a
// real file on disk. One canonical build keeps all copies in sync.
await mkdir("packages/codex/dist", { recursive: true });
await copyFile("plugins/glean/dist/index.js", "packages/codex/dist/index.js");
