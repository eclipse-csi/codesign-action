// Copyright (c) 2026 Eclipse Foundation AISBL and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License 2.0 which is available at
// https://www.eclipse.org/legal/epl-2.0/
//
// SPDX-License-Identifier: EPL-2.0

// Downloads csi-codesign (https://github.com/eclipse-csi/codesign-tools) and verifies it against
// the checksums pinned in checksums.json.
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { ActionError } = require('./core.js');
const CHECKSUMS = require('../checksums.json');

const RELEASES_URL = 'https://github.com/eclipse-csi/codesign-tools/releases/download';

// Node.js `${process.platform}-${process.arch}` -> platform suffix of the release archives.
const PLATFORMS = {
  'linux-x64': 'linux-x86_64',
  'linux-arm64': 'linux-aarch_64',
  'darwin-arm64': 'osx-aarch_64',
  'win32-x64': 'windows-x86_64',
};

/** Describes the release archive of csi-codesign `version` for a platform, and its checksum. */
function resolveAsset(
  version,
  platform = process.platform,
  arch = process.arch,
  checksums = CHECKSUMS,
) {
  const suffix = PLATFORMS[`${platform}-${arch}`];
  if (!suffix) {
    throw new ActionError(
      `csi-codesign has no native binary for ${platform}/${arch}. Supported runners: ` +
        'Linux x64 and arm64, macOS arm64, Windows x64.',
    );
  }
  const sums = Object.hasOwn(checksums.versions, version) ? checksums.versions[version] : null;
  if (!sums || !sums[suffix]) {
    throw new ActionError(
      `This release of the action has no checksum for csi-codesign ${version} on ${suffix}, so ` +
        `it cannot verify the download. Known versions: ${Object.keys(checksums.versions).join(', ')}. ` +
        'Use one of them, or update the action.',
    );
  }
  const windows = platform === 'win32';
  const archive = `csi-codesign-${version}-${suffix}.${windows ? 'zip' : 'tar.gz'}`;
  return {
    suffix,
    archive,
    url: `${RELEASES_URL}/v${version}/${archive}`,
    sha256: sums[suffix],
    binary: windows ? 'csi-codesign.exe' : 'csi-codesign',
  };
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function download(url, dest, { attempts = 3, log = console.log } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok) {
        const error = new Error(`GET ${url} answered HTTP ${response.status}`);
        error.retryable = response.status >= 500 || response.status === 429;
        throw error;
      }
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
      return;
    } catch (error) {
      if (attempt >= attempts || error.retryable === false) {
        throw error;
      }
      log(`Download failed (${error.message}), retrying (${attempt}/${attempts - 1})...`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

/** The command that extracts `archive` into `dir`. */
function extractCommand(archive, dir, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    // The bsdtar shipped with Windows reads zip files. Name it explicitly, so that the GNU tar of
    // Git for Windows, which does not, cannot shadow it on the PATH.
    const tar = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    return { command: tar, args: ['-xf', archive, '-C', dir] };
  }
  return { command: 'tar', args: ['-xzf', archive, '-C', dir] };
}

/**
 * Downloads csi-codesign `version`, verifies its archive against the checksum pinned in
 * checksums.json and extracts it into a fresh directory. Returns the path of the binary.
 *
 * The verified archive is kept in the runner's tool cache, so that later steps and jobs on the
 * same runner skip the download. It is verified again on every use and extracted anew, so that a
 * tampered cache entry, e.g. on a shared self-hosted runner, is detected.
 */
async function installCli(version, options = {}) {
  const {
    platform = process.platform,
    arch = process.arch,
    checksums = CHECKSUMS,
    toolCache = process.env.RUNNER_TOOL_CACHE || os.tmpdir(),
    tempDir = process.env.RUNNER_TEMP || os.tmpdir(),
    downloader = download,
    log = console.log,
  } = options;
  const asset = resolveAsset(version, platform, arch, checksums);

  const cacheDir = path.join(toolCache, 'csi-codesign', version, asset.suffix);
  const archive = path.join(cacheDir, asset.archive);
  if (fs.existsSync(archive) && (await sha256File(archive)) === asset.sha256) {
    log(`Using cached ${archive}`);
  } else {
    fs.mkdirSync(cacheDir, { recursive: true });
    const partial = `${archive}.${process.pid}.${crypto.randomUUID()}.part`;
    try {
      log(`Downloading ${asset.url}`);
      await downloader(asset.url, partial, { log });
      const actual = await sha256File(partial);
      if (actual !== asset.sha256) {
        throw new ActionError(
          `Checksum mismatch for ${asset.archive}: expected ${asset.sha256}, got ${actual}. ` +
            'The download is not the csi-codesign release this action was built for.',
        );
      }
      fs.renameSync(partial, archive);
    } finally {
      fs.rmSync(partial, { force: true });
    }
    log(`Verified ${asset.archive} (sha256 ${asset.sha256})`);
  }

  const dir = fs.mkdtempSync(path.join(tempDir, 'csi-codesign-'));
  const { command, args } = extractCommand(archive, dir, platform);
  const result = childProcess.spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Extracting ${archive} failed: ${result.error ? result.error.message : `exit code ${result.status}`}`,
    );
  }
  const binary = path.join(dir, asset.binary);
  if (!fs.existsSync(binary)) {
    throw new Error(`${asset.archive} does not contain ${asset.binary}`);
  }
  if (platform !== 'win32') {
    fs.chmodSync(binary, 0o755);
  }
  return binary;
}

module.exports = {
  PLATFORMS,
  RELEASES_URL,
  download,
  extractCommand,
  installCli,
  resolveAsset,
  sha256File,
};
