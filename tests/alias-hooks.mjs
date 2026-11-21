// Resolve hook mapping the `@/` tsconfig alias to the repo root, so a
// plain `node` run can import real TS modules (e.g. lib/providers.ts)
// without a bundler. Used only by local node checks, never by Next.js.
// Appends `.ts` for extensionless `@/` and relative imports (Node ESM
// does not), so the checked-in test files keep tsc-clean imports.
import {existsSync} from 'node:fs';

function withTsExtension(url) {
  if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(url.pathname)) return url;
  if (existsSync(url.pathname + '.ts')) return new URL(url.pathname + '.ts', url);
  if (existsSync(url.pathname + '.tsx')) return new URL(url.pathname + '.tsx', url);
  return url;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    return {url: withTsExtension(new URL('../' + specifier.slice(2), import.meta.url)).href, shortCircuit: true};
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return {url: withTsExtension(new URL(specifier, context.parentURL)).href, shortCircuit: true};
  }
  return nextResolve(specifier, context);
}
