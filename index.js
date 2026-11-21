// Copyright (c) 2026 Eclipse Foundation AISBL and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License 2.0 which is available at
// https://www.eclipse.org/legal/epl-2.0/
//
// SPDX-License-Identifier: EPL-2.0

// Signs files with SignPath through its GitHub trusted build system, by running csi-codesign
// (https://github.com/eclipse-csi/codesign-tools) in `github-actions` submission mode.
//
// Deliberately dependency-free, so that there is no bundled dist/ and no npm supply chain to
// trust. Being a JavaScript action also means the runner hands ACTIONS_RUNTIME_TOKEN to this
// process directly: the token goes to the csi-codesign child process only, and never becomes a
// step output.
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const CHECKSUMS = require('./checksums.json');

const RELEASES_URL = 'https://github.com/eclipse-csi/codesign-tools/releases/download';

// Node.js `${process.platform}-${process.arch}` -> platform suffix of the release archives.
const PLATFORMS = {
  'linux-x64': 'linux-x86_64',
  'linux-arm64': 'linux-aarch_64',
  'darwin-arm64': 'osx-aarch_64',
  'win32-x64': 'windows-x86_64',
};

// Variables the github-actions submission mode needs, on top of the two tokens.
const REQUIRED_RUNNER_ENV = [
  'ACTIONS_RESULTS_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'GITHUB_RUN_ID',
  'GITHUB_REPOSITORY',
];

// Credentials the runner gives this action that csi-codesign has no use for.
const STRIPPED_ENV = ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'];

/** An error caused by the workflow's inputs or environment: reported without a stack trace. */
class ActionError extends Error {}

// --- Workflow commands -------------------------------------------------------------------------

function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function mask(value) {
  if (value) {
    console.log(`::add-mask::${escapeData(value)}`);
  }
}

function getInput(name, { required = false } = {}, env = process.env) {
  const value = (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || '').trim();
  if (required && !value) {
    throw new ActionError(`Input required and not supplied: ${name}`);
  }
  return value;
}

function getBooleanInput(name, env = process.env) {
  const value = getInput(name, {}, env).toLowerCase();
  if (value === '' || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  throw new ActionError(`Input "${name}" must be "true" or "false", got "${value}".`);
}

function setOutput(name, value, env = process.env) {
  const outputFile = env.GITHUB_OUTPUT;
  if (!outputFile) {
    throw new ActionError('GITHUB_OUTPUT is not set; this action must run in a GitHub Actions job.');
  }
  const delimiter = `ghadelimiter_${crypto.randomUUID()}`;
  fs.appendFileSync(outputFile, `${name}<<${delimiter}${os.EOL}${value}${os.EOL}${delimiter}${os.EOL}`);
}

// --- Inputs ------------------------------------------------------------------------------------

/** Splits a multi-line input into its non-blank lines, skipping `#` comments. */
function lines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function isFile(file) {
  // A broken symbolic link has no stats; it is not a file to sign.
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * Expands the `files` input (one path or glob per line) into the list of files to sign, relative
 * to `cwd` unless a pattern is absolute. Every pattern must match at least one regular file.
 */
function expandFiles(spec, cwd = process.cwd()) {
  const patterns = lines(spec);
  if (patterns.length === 0) {
    throw new ActionError('No files to sign: the "files" input is empty.');
  }
  const files = new Map();
  for (const pattern of patterns) {
    const matches = fs
      .globSync(pattern, { cwd })
      .map((match) => path.normalize(match))
      .filter((match) => isFile(path.resolve(cwd, match)));
    if (matches.length === 0) {
      throw new ActionError(`No file matches "${pattern}" (relative to ${cwd}).`);
    }
    for (const match of matches) {
      files.set(path.resolve(cwd, match), match);
    }
  }
  return [...files.values()].sort();
}

/**
 * Several files are signed together as one zip, at its root, so their names must differ. Checked
 * here to fail before the CLI is even downloaded.
 */
function checkDistinctNames(files) {
  const seen = new Map();
  for (const file of files) {
    const name = path.basename(file);
    if (seen.has(name)) {
      throw new ActionError(
        `"${seen.get(name)}" and "${file}" have the same file name. Files signed together are ` +
          'packed at the root of one zip, so their names must be distinct; sign them in separate ' +
          'steps instead.',
      );
    }
    seen.set(name, file);
  }
}

/** Parses the `params` input: one `key=value` per line. */
function parseParams(spec) {
  return lines(spec).map((line) => {
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new ActionError(`Invalid "params" line "${line}": expected key=value.`);
    }
    return line;
  });
}

function parseTimeout(value) {
  if (value === '') {
    return '';
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ActionError(`Input "timeout" must be a positive number of seconds, got "${value}".`);
  }
  return value;
}

// --- csi-codesign installation -----------------------------------------------------------------

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

// --- Signing -----------------------------------------------------------------------------------

function buildArgs({
  organizationId,
  projectId,
  signingPolicy,
  artifactConfiguration = '',
  params = [],
  timeout = '',
  outputDir = '',
  verbose = false,
  files,
}) {
  return [
    'sign',
    '--submission-mode',
    'github-actions',
    '--organization-id',
    organizationId,
    '--project-id',
    projectId,
    '--signing-policy',
    signingPolicy,
    ...(artifactConfiguration ? ['--artifact-configuration', artifactConfiguration] : []),
    ...params.flatMap((param) => ['--param', param]),
    ...(timeout ? ['--wait-for-completion-timeout', timeout] : []),
    // Without an output directory, the files are signed in place, which --force-overwrite allows.
    // It is also what lets output-dir name the directory the files already are in.
    ...(outputDir ? ['--output-dir', outputDir] : []),
    '--force-overwrite',
    ...(verbose ? ['--verbose'] : []),
    '--',
    ...files,
  ];
}

/** Where csi-codesign writes each signed file. */
function signedPaths(files, outputDir) {
  return outputDir ? files.map((file) => path.join(outputDir, path.basename(file))) : files;
}

/**
 * The environment of csi-codesign: the runner's, minus the action inputs (the API token is one)
 * and the OIDC request credentials, plus the two tokens under the names the CLI reads.
 */
function childEnv(env, apiToken, githubToken) {
  const missing = REQUIRED_RUNNER_ENV.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new ActionError(
      `${missing.join(', ')} not set. This action must run as a step of a GitHub Actions job.`,
    );
  }
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.toUpperCase().startsWith('INPUT_') && !STRIPPED_ENV.includes(name.toUpperCase())) {
      result[name] = value;
    }
  }
  result.CSI_CODESIGN_API_TOKEN = apiToken;
  result.GITHUB_TOKEN = githubToken;
  return result;
}

async function run(env = process.env) {
  const apiToken = getInput('api-token', { required: true }, env);
  mask(apiToken);
  const githubToken = getInput('github-token', { required: true }, env);
  mask(githubToken);

  const outputDir = getInput('output-dir', {}, env);
  const options = {
    organizationId: getInput('organization-id', { required: true }, env),
    projectId: getInput('project-id', { required: true }, env),
    signingPolicy: getInput('signing-policy', { required: true }, env),
    artifactConfiguration: getInput('artifact-configuration', {}, env),
    params: parseParams(getInput('params', {}, env)),
    timeout: parseTimeout(getInput('timeout', {}, env)),
    outputDir,
    verbose: getBooleanInput('verbose', env) || env.RUNNER_DEBUG === '1',
  };
  const version = getInput('cli-version', {}, env) || CHECKSUMS.default;

  const files = expandFiles(getInput('files', { required: true }, env), process.cwd());
  checkDistinctNames(files);
  const spawnEnv = childEnv(env, apiToken, githubToken);

  console.log(`::group::Install csi-codesign ${version}`);
  let cli;
  try {
    cli = await installCli(version);
  } finally {
    console.log('::endgroup::');
  }

  console.log(
    `Signing ${files.length === 1 ? '1 file' : `${files.length} files in one request`}:\n` +
      files.map((file) => `  ${file}`).join('\n'),
  );
  const result = childProcess.spawnSync(cli, buildArgs({ ...options, files }), {
    stdio: 'inherit',
    env: spawnEnv,
  });
  if (result.error) {
    throw new Error(`Could not run ${cli}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    // csi-codesign has already printed why.
    throw new ActionError(
      `csi-codesign failed (exit code ${result.status ?? `signal ${result.signal}`}).`,
    );
  }
  setOutput('signed-files', signedPaths(files, outputDir).join('\n'), env);
}

module.exports = {
  ActionError,
  PLATFORMS,
  RELEASES_URL,
  buildArgs,
  checkDistinctNames,
  childEnv,
  download,
  expandFiles,
  extractCommand,
  getBooleanInput,
  getInput,
  installCli,
  parseParams,
  parseTimeout,
  resolveAsset,
  run,
  setOutput,
  sha256File,
  signedPaths,
};

if (require.main === module) {
  run().catch((error) => {
    const message = error instanceof ActionError ? error.message : error.stack || String(error);
    console.log(`::error::${escapeData(message)}`);
    process.exitCode = 1;
  });
}
