// Copyright (c) 2026 Eclipse Foundation AISBL and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License 2.0 which is available at
// https://www.eclipse.org/legal/epl-2.0/
//
// SPDX-License-Identifier: EPL-2.0
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach } = require('node:test');

const action = require('../index.js');
const checksums = require('../checksums.json');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesign-action-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function touch(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('checksums.json', () => {
  it('pins every platform of the default version', () => {
    const sums = checksums.versions[checksums.default];
    assert.ok(sums, `no entry for default version ${checksums.default}`);
    for (const suffix of ['linux-x86_64', 'linux-aarch_64', 'osx-aarch_64', 'windows-x86_64']) {
      assert.match(sums[suffix], /^[0-9a-f]{64}$/, suffix);
    }
  });
});

describe('resolveAsset', () => {
  const sums = { versions: { '1.2.3': { 'linux-x86_64': 'a'.repeat(64), 'windows-x86_64': 'b'.repeat(64) } } };

  it('maps Linux x64 to the tar.gz archive', () => {
    assert.deepEqual(action.resolveAsset('1.2.3', 'linux', 'x64', sums), {
      suffix: 'linux-x86_64',
      archive: 'csi-codesign-1.2.3-linux-x86_64.tar.gz',
      url: 'https://github.com/eclipse-csi/codesign-tools/releases/download/v1.2.3/csi-codesign-1.2.3-linux-x86_64.tar.gz',
      sha256: 'a'.repeat(64),
      binary: 'csi-codesign',
    });
  });

  it('maps Windows x64 to the zip archive and the .exe', () => {
    const asset = action.resolveAsset('1.2.3', 'win32', 'x64', sums);
    assert.equal(asset.archive, 'csi-codesign-1.2.3-windows-x86_64.zip');
    assert.equal(asset.binary, 'csi-codesign.exe');
  });

  it('maps every supported runner of the real checksums', () => {
    for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64'], ['win32', 'x64']]) {
      action.resolveAsset(checksums.default, platform, arch);
    }
  });

  it('rejects unsupported runners', () => {
    assert.throws(() => action.resolveAsset('1.2.3', 'darwin', 'x64', sums), /no native binary for darwin\/x64/);
  });

  it('rejects versions without a pinned checksum', () => {
    assert.throws(() => action.resolveAsset('9.9.9', 'linux', 'x64', sums), /no checksum for csi-codesign 9\.9\.9.*Known versions: 1\.2\.3/);
    assert.throws(() => action.resolveAsset('1.2.3', 'linux', 'arm64', sums), /no checksum/);
    assert.throws(() => action.resolveAsset('constructor', 'linux', 'x64', sums), /no checksum/);
  });
});

describe('expandFiles', () => {
  it('expands globs, skips comments and blank lines, removes duplicates and directories', (t) => {
    const dir = tempDir(t);
    touch(path.join(dir, 'dist', 'a.exe'));
    touch(path.join(dir, 'dist', 'b.exe'));
    touch(path.join(dir, 'dist', 'c.txt'));
    fs.mkdirSync(path.join(dir, 'dist', 'd.exe'));
    const files = action.expandFiles('# installers\ndist/*.exe\n\n  dist/a.exe  \n', dir);
    assert.deepEqual(files, [path.join('dist', 'a.exe'), path.join('dist', 'b.exe')]);
  });

  it('accepts absolute patterns', (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'app.jar');
    touch(file);
    assert.deepEqual(action.expandFiles(file, os.tmpdir()), [file]);
  });

  it('fails when a pattern matches nothing', (t) => {
    const dir = tempDir(t);
    touch(path.join(dir, 'a.exe'));
    assert.throws(() => action.expandFiles('a.exe\nmissing/*.dll', dir), /No file matches "missing\/\*\.dll"/);
  });

  it('fails when no pattern is given', () => {
    assert.throws(() => action.expandFiles('\n# nothing\n'), /input is empty/);
  });
});

describe('checkDistinctNames', () => {
  it('accepts distinct names', () => {
    action.checkDistinctNames(['win/app.exe', 'win/lib.dll']);
  });

  it('rejects files with the same name in different directories', () => {
    assert.throws(() => action.checkDistinctNames(['x64/app.exe', 'arm64/app.exe']), /same file name/);
  });
});

describe('parseParams and parseTimeout', () => {
  it('parses key=value lines, values may contain =', () => {
    assert.deepEqual(action.parseParams('version=1.0\n\nquery=a=b\n'), ['version=1.0', 'query=a=b']);
  });

  it('rejects lines without a key', () => {
    assert.throws(() => action.parseParams('=1.0'), /expected key=value/);
    assert.throws(() => action.parseParams('version'), /expected key=value/);
  });

  it('accepts positive integers or nothing', () => {
    assert.equal(action.parseTimeout(''), '');
    assert.equal(action.parseTimeout('1800'), '1800');
    for (const bad of ['0', '-1', '1.5', '10m', '012']) {
      assert.throws(() => action.parseTimeout(bad), /positive number of seconds/, bad);
    }
  });
});

describe('getInput and getBooleanInput', () => {
  it('reads INPUT_ variables, trimmed', () => {
    const env = { 'INPUT_PROJECT-ID': '  technology.csi\n' };
    assert.equal(action.getInput('project-id', {}, env), 'technology.csi');
    assert.equal(action.getInput('signing-policy', {}, env), '');
    assert.throws(() => action.getInput('signing-policy', { required: true }, env), /signing-policy/);
  });

  it('parses booleans strictly', () => {
    assert.equal(action.getBooleanInput('verbose', { INPUT_VERBOSE: 'TRUE' }), true);
    assert.equal(action.getBooleanInput('verbose', { INPUT_VERBOSE: 'false' }), false);
    assert.equal(action.getBooleanInput('verbose', {}), false);
    assert.throws(() => action.getBooleanInput('verbose', { INPUT_VERBOSE: 'yes' }), /"true" or "false"/);
  });
});

describe('buildArgs and signedPaths', () => {
  const base = { organizationId: 'org', projectId: 'proj', signingPolicy: 'test-signing' };

  it('signs in place by default, with the files after --', () => {
    assert.deepEqual(action.buildArgs({ ...base, files: ['-odd.jar', 'b.jar'] }), [
      'sign', '--submission-mode', 'github-actions',
      '--organization-id', 'org', '--project-id', 'proj', '--signing-policy', 'test-signing',
      '--force-overwrite', '--', '-odd.jar', 'b.jar',
    ]);
    assert.deepEqual(action.signedPaths(['dist/a.exe'], ''), ['dist/a.exe']);
  });

  it('passes every optional setting', () => {
    const args = action.buildArgs({
      ...base,
      artifactConfiguration: 'pe-file',
      params: ['version=1.0', 'channel=beta'],
      timeout: '1800',
      outputDir: 'signed',
      verbose: true,
      files: ['dist/a.exe'],
    });
    assert.deepEqual(args.slice(9), [
      '--artifact-configuration', 'pe-file',
      '--param', 'version=1.0', '--param', 'channel=beta',
      '--wait-for-completion-timeout', '1800',
      '--output-dir', 'signed', '--force-overwrite', '--verbose',
      '--', 'dist/a.exe',
    ]);
    assert.deepEqual(action.signedPaths(['dist/a.exe', 'lib/b.dll'], 'signed'), [
      path.join('signed', 'a.exe'),
      path.join('signed', 'b.dll'),
    ]);
  });
});

describe('childEnv', () => {
  const runner = {
    PATH: '/usr/bin',
    ACTIONS_RESULTS_URL: 'https://results',
    ACTIONS_RUNTIME_TOKEN: 'runtime',
    GITHUB_RUN_ID: '1',
    GITHUB_REPOSITORY: 'eclipse-foo/bar',
  };

  it('drops the inputs and the OIDC credentials, and adds the tokens', () => {
    const env = action.childEnv(
      { ...runner, 'INPUT_API-TOKEN': 'secret', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc', ACTIONS_ID_TOKEN_REQUEST_URL: 'u' },
      'api',
      'gh',
    );
    assert.deepEqual(env, { ...runner, CSI_CODESIGN_API_TOKEN: 'api', GITHUB_TOKEN: 'gh' });
  });

  it('fails outside of a GitHub Actions job', () => {
    assert.throws(() => action.childEnv({ PATH: '/usr/bin' }, 'api', 'gh'), /ACTIONS_RESULTS_URL, ACTIONS_RUNTIME_TOKEN/);
  });
});

describe('setOutput', () => {
  it('writes multi-line values with a delimiter', (t) => {
    const file = path.join(tempDir(t), 'output');
    action.setOutput('signed-files', 'a.exe\nb.dll', { GITHUB_OUTPUT: file });
    assert.match(fs.readFileSync(file, 'utf8'), /^signed-files<<(ghadelimiter_[0-9a-f-]+)\r?\na\.exe\nb\.dll\r?\n\1\r?\n$/);
  });
});

describe('installCli', () => {
  let dir;
  let fixture;
  let sums;
  let downloads;
  const windows = process.platform === 'win32';
  const binary = windows ? 'csi-codesign.exe' : 'csi-codesign';

  // A release-like archive with a fake binary, built with the same tar as the action extracts with.
  beforeEach((t) => {
    dir = tempDir(t);
    const content = path.join(dir, 'content');
    touch(path.join(content, binary), '#!/bin/sh\necho fake\n');
    fixture = path.join(dir, windows ? 'fixture.zip' : 'fixture.tar.gz');
    const { command } = action.extractCommand(fixture, content);
    const args = windows ? ['-a', '-cf', fixture, '-C', content, binary] : ['-czf', fixture, '-C', content, binary];
    childProcess.execFileSync(command, args);
    const asset = action.resolveAsset(checksums.default);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
    sums = { versions: { '1.2.3': { [asset.suffix]: sha256 } } };
    downloads = [];
  });

  function options(overrides = {}) {
    return {
      checksums: sums,
      toolCache: path.join(dir, 'cache'),
      tempDir: dir,
      log: () => {},
      downloader: async (url, dest) => {
        downloads.push(url);
        fs.copyFileSync(fixture, dest);
      },
      ...overrides,
    };
  }

  it('downloads, verifies and extracts the binary, then reuses the cached archive', async () => {
    const first = await action.installCli('1.2.3', options());
    assert.equal(path.basename(first), binary);
    assert.equal(fs.readFileSync(first, 'utf8'), '#!/bin/sh\necho fake\n');
    if (!windows) {
      assert.equal(fs.statSync(first).mode & 0o111, 0o111);
    }
    assert.equal(downloads.length, 1);
    assert.match(downloads[0], /\/v1\.2\.3\/csi-codesign-1\.2\.3-/);

    const second = await action.installCli('1.2.3', options());
    assert.equal(downloads.length, 1, 'the cached archive should be reused');
    assert.notEqual(path.dirname(second), path.dirname(first), 'each use extracts anew');
  });

  it('rejects a download with the wrong checksum and caches nothing', async () => {
    const tampered = options({
      downloader: async (url, dest) => fs.writeFileSync(dest, 'not the release'),
    });
    await assert.rejects(action.installCli('1.2.3', tampered), /Checksum mismatch/);
    const cacheDir = path.join(dir, 'cache', 'csi-codesign', '1.2.3');
    const left = fs.readdirSync(cacheDir, { recursive: true }).filter((f) => !fs.statSync(path.join(cacheDir, f)).isDirectory());
    assert.deepEqual(left, []);
  });

  it('downloads again when the cached archive was tampered with', async () => {
    await action.installCli('1.2.3', options());
    const cacheDir = path.join(dir, 'cache', 'csi-codesign', '1.2.3');
    const [suffix] = fs.readdirSync(cacheDir);
    const [archive] = fs.readdirSync(path.join(cacheDir, suffix));
    fs.writeFileSync(path.join(cacheDir, suffix, archive), 'tampered');

    await action.installCli('1.2.3', options());
    assert.equal(downloads.length, 2);
  });
});
