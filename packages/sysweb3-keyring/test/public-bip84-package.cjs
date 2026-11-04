/* Offline tarball/runtime/type-resolution check. Run after build and package copy. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'sysweb3-public-bip84-')
);
const env = {
  PATH: process.env.PATH,
  NPM_CONFIG_CACHE: path.join(directory, 'cache'),
  NPM_CONFIG_USERCONFIG: path.join(directory, 'empty-user-config'),
  NPM_CONFIG_GLOBALCONFIG: path.join(directory, 'empty-global-config'),
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  NODE_PATH: [
    path.join(packageRoot, 'node_modules'),
    path.join(repositoryRoot, 'node_modules'),
  ].join(path.delimiter),
};
function run(command, args, cwd = directory) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command}: ${result.stderr}\n${result.stdout}`
  );
  return result.stdout;
}
try {
  const [packed] = JSON.parse(
    run('npm', [
      'pack',
      path.join(packageRoot, 'dist'),
      '--offline',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      directory,
    ])
  );
  assert.equal(packed.name, '@sidhujag/sysweb3-keyring');
  const files = new Set(packed.files.map(({ path: file }) => file));
  for (const file of [
    'cjs/public-bip84.js',
    'types/public-bip84.d.ts',
    'cjs/bip84-native.js',
    'types/bip84-native.d.ts',
    'cjs/transactions/prepared-bip84.js',
    'types/transactions/prepared-bip84.d.ts',
    'package.json',
    'README.md',
  ])
    assert(files.has(file), `Tarball missing ${file}`);
  assert(
    ![...files].some((file) => /(?:^|\/)(?:src|test|tests)\//.test(file)),
    'Source/test files leaked into tarball'
  );
  const consumer = path.join(directory, 'consumer');
  const unpacked = path.join(
    consumer,
    'node_modules/@sidhujag/sysweb3-keyring'
  );
  fs.mkdirSync(unpacked, { recursive: true });
  run('tar', [
    '-xzf',
    path.join(directory, packed.filename),
    '--strip-components=1',
    '-C',
    unpacked,
  ]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8')
  );
  assert.match(
    fs.readFileSync(path.join(unpacked, 'README.md'), 'utf8'),
    /parseBip84PublicAccount/
  );
  assert(!Object.hasOwn(manifest, 'scripts'));
  assert(!Object.hasOwn(manifest, 'devDependencies'));
  for (const suffix of ['', '.js'])
    assert.deepEqual(manifest.typesVersions['*'][`cjs/public-bip84${suffix}`], [
      'types/public-bip84.d.ts',
    ]);
  for (const suffix of ['', '.js'])
    assert.deepEqual(manifest.typesVersions['*'][`cjs/bip84-native${suffix}`], [
      'types/bip84-native.d.ts',
    ]);
  run(
    process.execPath,
    [
      '-e',
      "require('node:assert/strict').equal(require('@sidhujag/sysweb3-keyring/cjs/public-bip84'), require('@sidhujag/sysweb3-keyring/cjs/public-bip84.js')); require('node:assert/strict').equal(require('@sidhujag/sysweb3-keyring/cjs/bip84-native'), require('@sidhujag/sysweb3-keyring/cjs/bip84-native.js'));",
    ],
    consumer
  );
  const entry = path.join(unpacked, 'cjs/public-bip84.js');
  process.stdout.write(
    run(
      process.execPath,
      [path.join(__dirname, 'public-bip84-runtime.cjs'), entry],
      consumer
    )
  );
  process.stdout.write(
    run(
      process.execPath,
      [
        path.join(__dirname, 'bip84-native-runtime.cjs'),
        path.join(unpacked, 'cjs/bip84-native.js'),
      ],
      consumer
    )
  );
  process.stdout.write(
    run(
      process.execPath,
      [
        path.join(__dirname, 'software-entry-runtime.cjs'),
        path.join(unpacked, 'cjs/software.js'),
      ],
      consumer
    )
  );
  fs.writeFileSync(
    path.join(consumer, 'consumer.ts'),
    `
import { parseBip84PublicAccount, deriveBip84PublicAddress, PublicBip84Error, Bip84PublicAccount } from '@sidhujag/sysweb3-keyring/cjs/public-bip84';
import { deriveBip84PublicAddress as withExtension } from '@sidhujag/sysweb3-keyring/cjs/public-bip84.js';
import { prepareBip84NativeTransaction, Bip84NativePlan } from '@sidhujag/sysweb3-keyring/cjs/bip84-native';
import { prepareBip84NativeTransaction as withNativeExtension } from '@sidhujag/sysweb3-keyring/cjs/bip84-native.js';
import type { SoftwareKeyring, PreparedBip84SigningRequest, SignedBip84NativeTransaction } from '@sidhujag/sysweb3-keyring/cjs/software.js';
declare const keyring: SoftwareKeyring;
declare const plan: Bip84NativePlan;
prepareBip84NativeTransaction(plan); withNativeExtension(plan);
keyring.deriveBip84HdPublicAccount({ network: { network: 'bitcoin', endpoint: 'https://offline.invalid' }, accountIndex: 1 }, { assertCurrent() {} });
declare const signing: PreparedBip84SigningRequest;
const signed: Promise<SignedBip84NativeTransaction> = keyring.signPreparedBip84Transaction(signing, { assertCurrent() {} });
void signed;
// @ts-expect-error mandatory guard
keyring.signPreparedBip84Transaction(signing);
// @ts-expect-error only selected HD accounts, no imported scalar signing
const unsupported: PreparedBip84SigningRequest = { account: { type: 'Imported', index: 0, expectedAccountKey: '' }, prepared: signing.prepared };
void unsupported;
const request = { network: 'syscoin' as const, accountKey: 'public fixture' };
const account: Bip84PublicAccount = parseBip84PublicAccount(request);
const result = deriveBip84PublicAddress({ ...request, branch: 1, index: 7 });
withExtension({ ...request, branch: 0, index: 0 });
const text: string = result.address + result.scriptPubKey + account.canonicalKey;
const error: string = new PublicBip84Error('INVALID_ACCOUNT').code;
void text; void error;
// @ts-expect-error unsupported network
parseBip84PublicAccount({ ...request, network: 'testnet' });
// @ts-expect-error hardened/arbitrary branch disallowed
withExtension({ ...request, branch: 2, index: 0 });
// @ts-expect-error immutable result
result.index = 9;
// @ts-expect-error immutable account
result.account.network = 'bitcoin';
// @ts-expect-error private authority is not exposed
result.privateKey;
`
  );
  run(
    process.execPath,
    [
      path.join(repositoryRoot, 'node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--skipLibCheck',
      '--target',
      'es2020',
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--types',
      'node',
      '--typeRoots',
      path.join(repositoryRoot, 'node_modules/@types'),
      path.join(consumer, 'consumer.ts'),
    ],
    consumer
  );
  process.stdout.write(
    `Offline package: tarball ${packed.shasum}, both public entry type spellings and negative TypeScript controls passed.\n`
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
