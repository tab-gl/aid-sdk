#!/usr/bin/env node
/**
 * Verify package exports after `npm run build`.
 *
 * Consumers should not discover broken conditional exports, missing ESM/CJS
 * declarations, or SSR-unsafe module initialization only after publishing.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const require = createRequire(import.meta.url);
let failures = 0;

function fail(message) {
  console.error(`✗ ${message}`);
  failures += 1;
}

function pass(message) {
  console.log(`✓ ${message}`);
}

function flattenTargets(value, conditions = [], targets = []) {
  if (typeof value === 'string') {
    targets.push({ conditions, target: value });
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [condition, target] of Object.entries(value)) {
      flattenTargets(target, [...conditions, condition], targets);
    }
  }
  return targets;
}

function runtimeTarget(conditions, runtime) {
  const branch = conditions?.[runtime];
  if (typeof branch === 'string') return branch;
  return typeof branch?.default === 'string' ? branch.default : undefined;
}

function typesTarget(conditions, runtime) {
  const branch = conditions?.[runtime];
  if (typeof branch?.types === 'string') return branch.types;
  return typeof conditions?.types === 'string' ? conditions.types : undefined;
}

function displaySubpath(subpath) {
  return subpath === '.' ? 'ace-id-sdk' : `ace-id-sdk${subpath.slice(1)}`;
}

// 1. Every nested condition target exists.
const allTargets = [];
for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
  const targets = flattenTargets(conditions);
  if (targets.length === 0) fail(`exports["${subpath}"] has no targets`);
  for (const { conditions: route, target } of targets) {
    allTargets.push(target);
    if (!existsSync(target)) {
      fail(`exports["${subpath}"].${route.join('.')} → ${target} does not exist`);
    }
  }
}
if (failures === 0) pass(`all ${Object.keys(pkg.exports ?? {}).length} export subpaths resolve in ESM/CJS/type conditions`);

// 2. Each runtime entry point is independently loadable in Node.
for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
  const label = displaySubpath(subpath);
  const importTarget = runtimeTarget(conditions, 'import');
  if (!importTarget) {
    fail(`${label} has no ESM runtime target`);
  } else {
    try {
      const module = await import(pathToFileURL(resolve(importTarget)).href);
      if (!module || typeof module !== 'object' || Object.keys(module).length === 0) {
        throw new Error('module exported nothing');
      }
      pass(`${label} imports standalone (${Object.keys(module).length} ESM exports)`);
    } catch (error) {
      fail(`${label} ESM import failed: ${error.message}`);
    }
  }

  const requireTarget = runtimeTarget(conditions, 'require');
  if (!requireTarget) {
    fail(`${label} has no CommonJS runtime target`);
  } else {
    try {
      const module = require(resolve(requireTarget));
      if (!module || typeof module !== 'object' || Object.keys(module).length === 0) {
        throw new Error('module exported nothing');
      }
      pass(`${label} requires standalone (${Object.keys(module).length} CJS exports)`);
    } catch (error) {
      fail(`${label} CommonJS require failed: ${error.message}`);
    }
  }
}

// 3. Built files contain no leaked citation markers or sandbox paths.
for (const target of new Set(allTargets)) {
  if (!existsSync(target) || !/\.(?:c?js|d\.cts|d\.ts)$/.test(target)) continue;
  const source = readFileSync(target, 'utf8');
  if (source.includes('[cite:')) fail(`${target} contains a leftover citation marker`);
  if (/\/scratch\//.test(source)) fail(`${target} contains a machine-specific path`);
}

// 4. Both NodeNext type-resolution modes must have explicit declarations.
for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
  for (const runtime of ['import', 'require']) {
    const types = typesTarget(conditions, runtime);
    if (!types) {
      fail(`${displaySubpath(subpath)} has no ${runtime} type declaration target`);
    } else if (!existsSync(types)) {
      fail(`${displaySubpath(subpath)} ${runtime} types are missing: ${types}`);
    }
  }
}

// 5. Package metadata and core payload.
for (const file of ['README.md', 'LICENSE', 'FONT-LICENSE.txt']) {
  if (existsSync(file)) pass(`${file} present`);
  else fail(`${file} missing from the repository root`);
}
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
if (!semverPattern.test(pkg.version)) fail(`package version is not semantic: ${pkg.version}`);
if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
  fail(`package.json (${pkg.version}) and package-lock.json versions do not match`);
} else {
  pass(`package.json and package-lock.json agree on version ${pkg.version}`);
}

// 6. The browser entry can be imported and instantiated on an SSR server when
// the host injects a storage adapter; no window or document global is required.
try {
  const importTarget = runtimeTarget(pkg.exports?.['.'], 'import');
  if (!importTarget) throw new Error('root ESM entry is missing');
  const module = await import(pathToFileURL(resolve(importTarget)).href);
  const client = new module.AID({
    issuer: 'https://identity.example.test',
    clientId: 'ssr-check',
    redirectUri: 'https://app.example.test/callback',
    storage: new module.MemoryStorage(),
  });
  if (client.getSession() !== null) throw new Error('new SSR client unexpectedly has a session');
  pass('root ESM entry is SSR-safe with an explicit storage adapter');
} catch (error) {
  fail(`SSR import/client check failed: ${error.message}`);
}

if (failures > 0) {
  console.error(`\n${failures} package check(s) failed.`);
  process.exit(1);
}
console.log('\nAll package checks passed.');
