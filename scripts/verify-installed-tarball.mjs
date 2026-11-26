#!/usr/bin/env node
/** Install the packed SDK into a clean consumer and verify its public surface. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const tarballArg = process.argv[2];
if (!tarballArg) {
  console.error('Usage: npm run verify:tarball -- <path-to-tarball>');
  process.exit(2);
}

const tarball = resolve(tarballArg);
assert.ok(existsSync(tarball), `Tarball does not exist: ${tarball}`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const workspace = mkdtempSync(join(tmpdir(), 'ace-id-sdk-consumer-'));
const run = (command, args, cwd = workspace) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        result.error?.message,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result.stdout ?? '';
};

try {
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'ace-id-sdk-consumer', private: true, type: 'module' }, null, 2),
  );

  // React is an optional peer dependency, so install it to exercise that entry.
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarball,
    'react@18.3.1',
    '@types/react@18.3.28',
  ]);

  const installedRoot = join(workspace, 'node_modules', sourcePackage.name);
  const installedPackage = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installedPackage.version, sourcePackage.version, 'installed package version mismatch');

  const specifiers = Object.keys(installedPackage.exports).map((subpath) =>
    subpath === '.' ? installedPackage.name : `${installedPackage.name}${subpath.slice(1)}`,
  );
  for (const specifier of specifiers) {
    run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(specifier)});`]);
    run(process.execPath, ['-e', `require(${JSON.stringify(specifier)});`]);
  }
  console.log(`✓ all ${specifiers.length} public subpaths load in ESM and CommonJS`);

  const ssrCheck = `
    const { AID, MemoryStorage } = await import('ace-id-sdk');
    const client = new AID({
      issuer: 'https://identity.example.test',
      clientId: 'tarball-check',
      redirectUri: 'https://app.example.test/callback',
      storage: new MemoryStorage(),
    });
    if (client.getSession() !== null) throw new Error('Unexpected initial session');
  `;
  run(process.execPath, ['--input-type=module', '-e', ssrCheck]);
  run(process.execPath, [
    '-e',
    `const { AID, MemoryStorage } = require('ace-id-sdk'); const client = new AID({ issuer: 'https://identity.example.test', clientId: 'tarball-check', redirectUri: 'https://app.example.test/callback', storage: new MemoryStorage() }); if (client.getSession() !== null) throw new Error('Unexpected initial session');`,
  ]);
  console.log('✓ SSR client construction with explicit storage passes in ESM and CommonJS');

  const pkceEsm = `
    import { createCodeVerifier, createCodeChallenge } from 'ace-id-sdk';
    const verifier = createCodeVerifier();
    if (verifier.length !== 43) throw new Error('Unexpected verifier length');
    const challenge = await createCodeChallenge(verifier);
    if (challenge.length !== 43) throw new Error('Unexpected challenge length');
  `;
  run(process.execPath, ['--input-type=module', '-e', pkceEsm]);
  run(process.execPath, [
    '-e',
    `const { createCodeVerifier, createCodeChallenge } = require('ace-id-sdk'); (async () => { const verifier = createCodeVerifier(); if (verifier.length !== 43) throw new Error('Unexpected verifier length'); const challenge = await createCodeChallenge(verifier); if (challenge.length !== 43) throw new Error('Unexpected challenge length'); })().catch((error) => { console.error(error); process.exitCode = 1; });`,
  ]);
  console.log('✓ Web Crypto PKCE generation passes in ESM and CommonJS');

  const imports = specifiers
    .map((specifier, index) => `import * as subpath${index} from ${JSON.stringify(specifier)};\nvoid subpath${index};`)
    .join('\n');
  writeFileSync(join(workspace, 'typecheck.mts'), `${imports}\n`);
  writeFileSync(join(workspace, 'typecheck.cts'), `${imports}\n`);
  writeFileSync(
    join(workspace, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['./typecheck.mts', './typecheck.cts'],
      },
      null,
      2,
    ),
  );

  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const trace = run(process.execPath, [tsc, '--project', 'tsconfig.json', '--traceResolution']);
  assert.match(trace, /dist[\\/]index\.d\.ts/);
  assert.match(trace, /dist[\\/]index\.d\.cts/);
  console.log('✓ NodeNext resolves ESM .d.ts and CommonJS .d.cts declarations for every subpath');

  const bundle = (contents) =>
    buildSync({
      stdin: { contents, resolveDir: workspace, sourcefile: 'consumer.js' },
      bundle: true,
      treeShaking: true,
      minify: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    }).outputFiles[0].contents.byteLength;
  const namedBytes = bundle(
    "import { createCodeVerifier } from 'ace-id-sdk'; console.log(typeof createCodeVerifier);",
  );
  const namespaceBytes = bundle("import * as SDK from 'ace-id-sdk'; console.log(SDK);");
  assert.ok(
    namedBytes < namespaceBytes,
    `named import (${namedBytes} B) should tree-shake smaller than namespace import (${namespaceBytes} B)`,
  );
  console.log(`✓ tree-shaking: named ${namedBytes} B, namespace ${namespaceBytes} B`);
  console.log(`Installed tarball verification passed for ${sourcePackage.name}@${sourcePackage.version}.`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
