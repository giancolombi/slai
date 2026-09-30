// Bundles the Node services into self-contained ESM files for the container
// images (T-63): `node deploy/bundle.mjs <api|worker|ops> <outdir>`.
// Every dependency is bundled except native addons, which the image copies in.
import { build } from "esbuild";

const ENTRIES = {
  api: {
    api: "apps/api/src/index.ts",
    // The api image is also the migrate image (and Railway's pre-deploy command).
    migrate: "packages/db/src/scripts/migrate.ts",
    seed: "packages/db/src/scripts/seed.ts",
    "keys-rotate": "packages/db/src/scripts/rotate-keys.ts",
  },
  worker: { worker: "apps/worker/src/index.ts" },
  ops: {
    backup: "packages/db/src/scripts/backup.ts",
    restore: "packages/db/src/scripts/restore.ts",
  },
};

const [target, outdir] = process.argv.slice(2);
const entryPoints = ENTRIES[target];
if (!entryPoints || !outdir) {
  console.error("usage: node deploy/bundle.mjs <api|worker|ops> <outdir>");
  process.exit(1);
}

await build({
  entryPoints,
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Native addon: resolved at runtime from node_modules in the image.
  external: ["@node-rs/argon2"],
  // CommonJS dependencies call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __slaiRequire } from 'node:module'; const require = __slaiRequire(import.meta.url);",
  },
  legalComments: "none",
  sourcemap: false,
  logLevel: "warning",
});
console.log(`bundled ${target} -> ${outdir}`);
