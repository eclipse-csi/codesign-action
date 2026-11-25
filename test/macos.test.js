// Copyright (c) 2026 Eclipse Foundation AISBL and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License 2.0 which is available at
// https://www.eclipse.org/legal/epl-2.0/
//
// SPDX-License-Identifier: EPL-2.0
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const macos = require('../macos/index.js');
const core = require('../lib/core.js');
const checksums = require('../checksums.json');

// Not a key, only the shape of a .p8 file. The markers are assembled, so that the secret scanners
// of the git hooks do not take this file for one.
const marker = (kind) => `-----${kind} PRIVATE ${'KEY'}-----`;
const PEM = `${marker('BEGIN')}\nMIGTAgEAMBMGByqGSM49\nAgEGCCqGSM49\n${marker('END')}`;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesign-action-macos-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function touch(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Silences the workflow commands and progress messages an action prints while `fn` runs. */
async function quietly(t, fn) {
  t.mock.method(console, 'log', () => {});
  return fn();
}

describe('expandFiles for macOS', () => {
  const bundles = { directories: true, sort: false };

  it('matches bundles and files, in the order of the patterns', (t) => {
    const dir = tempDir(t);
    touch(path.join(dir, 'build', 'Zed.app', 'Contents', 'MacOS', 'Zed'));
    touch(path.join(dir, 'build', 'Alpha.app', 'Contents', 'MacOS', 'Alpha'));
    touch(path.join(dir, 'build', 'tool'));
    const files = core.expandFiles('build/tool\nbuild/*.app/\nbuild/Zed.app', dir, bundles);
    assert.deepEqual(files, [
      path.join('build', 'tool'),
      path.join('build', 'Alpha.app'),
      path.join('build', 'Zed.app'),
    ]);
  });

  it('still ignores directories by default', (t) => {
    const dir = tempDir(t);
    touch(path.join(dir, 'build', 'Zed.app', 'Contents', 'MacOS', 'Zed'));
    assert.throws(() => core.expandFiles('build/*.app', dir), /No file matches/);
  });

  it('fails when a pattern matches nothing', (t) => {
    const dir = tempDir(t);
    assert.throws(() => core.expandFiles('build/*.app', dir, bundles), /No file or directory matches "build\/\*\.app"/);
  });
});

describe('checkCliVersion', () => {
  const sums = { versions: { '0.10.1': {}, '0.12.0': {}, '0.12.1': {}, '1.0.0': {} } };

  it('accepts 0.12.0 and later', () => {
    for (const version of ['0.12.0', '0.12.1', '1.0.0']) {
      macos.checkCliVersion(version, sums);
    }
  });

  it('rejects the known versions without the macos commands', () => {
    assert.throws(() => macos.checkCliVersion('0.10.1', sums), /needs csi-codesign 0\.12\.0 or later/);
  });

  it('leaves unknown versions to the installation', () => {
    macos.checkCliVersion('0.1.0', sums);
    macos.checkCliVersion('constructor', sums);
  });

  it('accepts the default version of the action', () => {
    macos.checkCliVersion(checksums.default);
  });

  it('compares versions numerically', () => {
    assert.equal(macos.compareVersions('0.9.0', '0.12.0'), -1);
    assert.equal(macos.compareVersions('0.12.0', '0.12.0'), 0);
    assert.equal(macos.compareVersions('1.0.0', '0.12.0'), 1);
  });
});

describe('normalizeNotaryKey', () => {
  it('keeps the content of a .p8 file, with one trailing newline', () => {
    assert.equal(macos.normalizeNotaryKey(`${PEM}\n\n`), `${PEM}\n`);
    assert.equal(macos.normalizeNotaryKey(PEM), `${PEM}\n`);
  });

  it('decodes its base64 encoding, wrapped or not', () => {
    const encoded = Buffer.from(`${PEM}\n`).toString('base64');
    assert.equal(macos.normalizeNotaryKey(encoded), `${PEM}\n`);
    const wrapped = encoded.replace(/(.{20})/g, '$1\n');
    assert.equal(macos.normalizeNotaryKey(wrapped), `${PEM}\n`);
  });

  it('rejects anything else', () => {
    for (const bad of ['ABC123DEFG', 'not base64!', Buffer.from('hello').toString('base64')]) {
      assert.throws(() => macos.normalizeNotaryKey(bad), /content of the App Store Connect API key/, bad);
    }
  });
});

describe('buildSignArgs and buildNotarizeArgs', () => {
  const base = { organizationId: 'org', projectId: 'proj', signingPolicy: 'apple-application-release' };

  it('signs in place by default, with the inputs after --', () => {
    assert.deepEqual(macos.buildSignArgs({ ...base, files: ['build/My.app', '-odd'] }), [
      'macos', 'sign',
      '--organization-id', 'org', '--project-id', 'proj', '--signing-policy', 'apple-application-release',
      '--force-overwrite', '--', 'build/My.app', '-odd',
    ]);
  });

  it('passes every optional signing setting', () => {
    const args = macos.buildSignArgs({
      ...base,
      identity: 'Developer ID Application: Example',
      installerIdentity: 'Developer ID Installer: Example',
      entitlements: 'My.entitlements',
      identityTimeout: '120',
      signingTimeout: '600',
      ctkSha256: 'a'.repeat(64),
      outputDir: 'signed',
      verbose: true,
      files: ['build/My.app'],
    });
    assert.deepEqual(args.slice(8), [
      '--identity', 'Developer ID Application: Example',
      '--installer-identity', 'Developer ID Installer: Example',
      '--entitlements', 'My.entitlements',
      '--identity-timeout', '120',
      '--signing-timeout', '600',
      '--ctk-sha256', 'a'.repeat(64),
      '--output-dir', 'signed', '--force-overwrite', '--verbose',
      '--', 'build/My.app',
    ]);
  });

  it('notarizes and staples by default', () => {
    assert.deepEqual(macos.buildNotarizeArgs({ files: ['signed/My.dmg'] }), [
      'macos', 'notarize', '--', 'signed/My.dmg',
    ]);
  });

  it('passes every optional notarization setting', () => {
    const args = macos.buildNotarizeArgs({ timeout: '900', staple: false, verbose: true, files: ['a.dmg', 'b.pkg'] });
    assert.deepEqual(args, [
      'macos', 'notarize', '--wait-for-completion-timeout', '900', '--no-staple', '--verbose',
      '--', 'a.dmg', 'b.pkg',
    ]);
  });
});

describe('signEnv and notarizeEnv', () => {
  const kept = { PATH: '/usr/bin', HOME: '/Users/runner', GITHUB_RUN_ID: '1' };
  const runner = {
    ...kept,
    'INPUT_API-TOKEN': 'input-secret',
    'INPUT_NOTARY-KEY': 'input-key',
    ACTIONS_RUNTIME_TOKEN: 'runtime',
    ACTIONS_RESULTS_URL: 'https://results',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc',
    // Set by the workflow for an earlier step, say.
    CSI_CODESIGN_API_TOKEN: 'inherited-token',
    CSI_CODESIGN_NOTARY_KEY: 'inherited-key',
    CSI_CODESIGN_NOTARY_KEY_ID: 'inherited-id',
    CSI_CODESIGN_NOTARY_ISSUER: 'inherited-issuer',
  };

  it('gives signing the SignPath API token only', () => {
    assert.deepEqual(macos.signEnv(runner, 'api'), { ...kept, CSI_CODESIGN_API_TOKEN: 'api' });
  });

  it('gives notarization the App Store Connect API key only', () => {
    assert.deepEqual(macos.notarizeEnv(runner, { key: 'key', keyId: 'id', issuer: 'issuer' }), {
      ...kept,
      CSI_CODESIGN_NOTARY_KEY: 'key',
      CSI_CODESIGN_NOTARY_KEY_ID: 'id',
      CSI_CODESIGN_NOTARY_ISSUER: 'issuer',
    });
  });

  it('leaves the issuer out for individual keys', () => {
    assert.deepEqual(macos.notarizeEnv(runner, { key: 'key', keyId: 'id' }), {
      ...kept,
      CSI_CODESIGN_NOTARY_KEY: 'key',
      CSI_CODESIGN_NOTARY_KEY_ID: 'id',
    });
  });
});

describe('run', () => {
  const windows = process.platform === 'win32';

  /**
   * A workspace with an app, a tool and a fake csi-codesign that appends its arguments and the
   * credentials it sees to calls.log, and fails when FAKE_FAIL names its subcommand.
   */
  function workspace(t) {
    const dir = tempDir(t);
    touch(path.join(dir, 'build', 'My.app', 'Contents', 'MacOS', 'My'));
    touch(path.join(dir, 'build', 'tool'));
    touch(path.join(dir, 'My.entitlements'));
    const cli = path.join(dir, 'csi-codesign');
    touch(
      cli,
      [
        '#!/bin/sh',
        '{',
        '  printf "args:"; for arg in "$@"; do printf " [%s]" "$arg"; done; echo',
        '  echo "token:${CSI_CODESIGN_API_TOKEN:-none}"',
        '  echo "key:${CSI_CODESIGN_NOTARY_KEY:-none}"',
        '  echo "key-id:${CSI_CODESIGN_NOTARY_KEY_ID:-none} issuer:${CSI_CODESIGN_NOTARY_ISSUER:-none}"',
        '  echo "runtime:${ACTIONS_RUNTIME_TOKEN:-none}"',
        '} >> calls.log',
        'if [ "$2" = "${FAKE_FAIL:-}" ]; then exit 1; fi',
        '',
      ].join('\n'),
    );
    fs.chmodSync(cli, 0o755);
    const installed = [];
    return {
      dir,
      output: path.join(dir, 'output'),
      dependencies: {
        cwd: dir,
        platform: 'darwin',
        installer: async (version) => {
          installed.push(version);
          return cli;
        },
      },
      installed,
      calls: () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8'),
      outputs: () => fs.readFileSync(path.join(dir, 'output'), 'utf8'),
    };
  }

  function inputs(ws, extra = {}) {
    return {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: ws.output,
      ACTIONS_RUNTIME_TOKEN: 'runtime',
      'INPUT_API-TOKEN': 'signpath-token',
      'INPUT_ORGANIZATION-ID': 'org',
      'INPUT_PROJECT-ID': 'proj',
      'INPUT_SIGNING-POLICY': 'apple-application-release',
      INPUT_FILES: 'build/My.app\nbuild/tool',
      INPUT_NOTARIZE: 'false',
      INPUT_STAPLE: 'true',
      INPUT_VERBOSE: 'false',
      ...extra,
    };
  }

  it('signs in place, without notarizing', { skip: windows }, async (t) => {
    const ws = workspace(t);
    await quietly(t, () => macos.run(inputs(ws), ws.dependencies));
    assert.deepEqual(ws.installed, [checksums.default]);
    assert.equal(
      ws.calls(),
      'args: [macos] [sign] [--organization-id] [org] [--project-id] [proj] [--signing-policy]' +
        ' [apple-application-release] [--force-overwrite] [--] [build/My.app] [build/tool]\n' +
        'token:signpath-token\nkey:none\nkey-id:none issuer:none\nruntime:none\n',
    );
    assert.match(ws.outputs(), /^signed-files<<(\S+)\nbuild\/My\.app\nbuild\/tool\n\1\n$/);
  });

  it('signs to the output directory, then notarizes what it signed', { skip: windows }, async (t) => {
    const ws = workspace(t);
    const env = inputs(ws, {
      'INPUT_OUTPUT-DIR': 'signed',
      INPUT_ENTITLEMENTS: 'My.entitlements',
      INPUT_NOTARIZE: 'true',
      'INPUT_NOTARY-KEY': Buffer.from(`${PEM}\n`).toString('base64'),
      'INPUT_NOTARY-KEY-ID': 'ABC123DEFG',
      'INPUT_NOTARY-ISSUER': 'issuer-uuid',
      'INPUT_NOTARIZE-TIMEOUT': '900',
    });
    await quietly(t, () => macos.run(env, ws.dependencies));
    const [sign, notarize] = ws.calls().split(/(?=^args:)/m);
    assert.match(sign, /\[--entitlements\] \[My\.entitlements\] \[--output-dir\] \[signed\] \[--force-overwrite\] \[--\] \[build\/My\.app\] \[build\/tool\]\n/);
    assert.match(sign, /^token:signpath-token\nkey:none\nkey-id:none issuer:none$/m);
    assert.equal(
      notarize,
      'args: [macos] [notarize] [--wait-for-completion-timeout] [900] [--] [signed/My.app] [signed/tool]\n' +
        // The key ends with a newline, and so does the line that prints it.
        `token:none\nkey:${PEM}\n\nkey-id:ABC123DEFG issuer:issuer-uuid\nruntime:none\n`,
    );
    assert.match(ws.outputs(), /\nsigned\/My\.app\nsigned\/tool\n/);
  });

  it('does not notarize when signing fails', { skip: windows }, async (t) => {
    const ws = workspace(t);
    const env = inputs(ws, {
      FAKE_FAIL: 'sign',
      INPUT_NOTARIZE: 'true',
      'INPUT_NOTARY-KEY': PEM,
      'INPUT_NOTARY-KEY-ID': 'ABC123DEFG',
    });
    await assert.rejects(quietly(t, () => macos.run(env, ws.dependencies)), /csi-codesign failed \(exit code 1\)/);
    assert.equal(ws.calls().match(/^args:/gm).length, 1);
    assert.equal(fs.existsSync(ws.output), false);
  });

  it('reports the signed files even when notarization fails', { skip: windows }, async (t) => {
    const ws = workspace(t);
    const env = inputs(ws, {
      FAKE_FAIL: 'notarize',
      INPUT_NOTARIZE: 'true',
      'INPUT_NOTARY-KEY': PEM,
      'INPUT_NOTARY-KEY-ID': 'ABC123DEFG',
    });
    await assert.rejects(quietly(t, () => macos.run(env, ws.dependencies)), /csi-codesign failed/);
    assert.match(ws.outputs(), /\nbuild\/My\.app\nbuild\/tool\n/);
  });

  it('masks the SignPath token and both forms of the notary key', async (t) => {
    const ws = workspace(t);
    const encoded = Buffer.from(PEM).toString('base64');
    const env = inputs(ws, {
      INPUT_NOTARIZE: 'true',
      'INPUT_NOTARY-KEY': encoded,
      'INPUT_NOTARY-KEY-ID': 'ABC123DEFG',
      'INPUT_CLI-VERSION': '0.10.1', // stops the run right after the inputs are read
    });
    const log = t.mock.method(console, 'log', () => {});
    await assert.rejects(macos.run(env, ws.dependencies), /needs csi-codesign/);
    const printed = log.mock.calls.map((call) => call.arguments[0]);
    assert.deepEqual(printed, [
      '::add-mask::signpath-token',
      `::add-mask::${encoded}`,
      `::add-mask::${PEM.replace(/\n/g, '%0A')}`,
    ]);
  });

  describe('fails before installing csi-codesign', () => {
    const cases = {
      'on a runner that is not macOS': [{}, { platform: 'linux' }, /macOS runners only/],
      'with a csi-codesign without the macos commands': [{ 'INPUT_CLI-VERSION': '0.10.1' }, {}, /needs csi-codesign 0\.12\.0 or later/],
      'without the API token': [{ 'INPUT_API-TOKEN': '' }, {}, /Input required and not supplied: api-token/],
      'without the signing policy': [{ 'INPUT_SIGNING-POLICY': '' }, {}, /signing-policy/],
      'when notarizing without a key': [{ INPUT_NOTARIZE: 'true', 'INPUT_NOTARY-KEY-ID': 'ABC' }, {}, /"notary-key" and "notary-key-id" are required/],
      'when notarizing without a key ID': [{ INPUT_NOTARIZE: 'true', 'INPUT_NOTARY-KEY': PEM }, {}, /"notary-key" and "notary-key-id" are required/],
      'with a notary key that is not a key': [{ INPUT_NOTARIZE: 'true', 'INPUT_NOTARY-KEY': 'nope', 'INPUT_NOTARY-KEY-ID': 'ABC' }, {}, /content of the App Store Connect API key/],
      'with an invalid boolean': [{ INPUT_NOTARIZE: 'yes' }, {}, /"notarize" must be "true" or "false"/],
      'with an invalid timeout': [{ 'INPUT_SIGNING-TIMEOUT': '5m' }, {}, /"signing-timeout" must be a positive number of seconds/],
      'with an invalid CryptoTokenKit checksum': [{ 'INPUT_CTK-SHA256': 'abc' }, {}, /"ctk-sha256" must be a SHA-256/],
      'with missing entitlements': [{ INPUT_ENTITLEMENTS: 'missing.plist' }, {}, /entitlements file "missing\.plist" does not exist/],
      'when nothing matches': [{ INPUT_FILES: 'build/*.dmg' }, {}, /No file or directory matches/],
      'when two inputs would get the same name in the output directory': [
        { INPUT_FILES: 'build/tool\nother/tool', 'INPUT_OUTPUT-DIR': 'signed' },
        {},
        /same file name\. The inputs are copied to the output directory/,
      ],
    };
    for (const [name, [extra, dependencies, expected]] of Object.entries(cases)) {
      it(name, async (t) => {
        const ws = workspace(t);
        touch(path.join(ws.dir, 'other', 'tool'));
        const run = () => macos.run(inputs(ws, extra), { ...ws.dependencies, ...dependencies });
        await assert.rejects(quietly(t, run), expected);
        assert.deepEqual(ws.installed, []);
      });
    }
  });

  it('ignores the notarization inputs when notarize is false', { skip: windows }, async (t) => {
    const ws = workspace(t);
    const env = inputs(ws, { 'INPUT_NOTARY-KEY': PEM, 'INPUT_NOTARY-KEY-ID': 'ABC123DEFG' });
    await quietly(t, () => macos.run(env, ws.dependencies));
    assert.equal(ws.calls().match(/^args:/gm).length, 1);
    assert.match(ws.calls(), /^key:none$/m);
  });
});
