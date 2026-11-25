// Copyright (c) 2026 Eclipse Foundation AISBL and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License 2.0 which is available at
// https://www.eclipse.org/legal/epl-2.0/
//
// SPDX-License-Identifier: EPL-2.0

// Signs macOS apps, binaries, disk images and installer packages with the certificate of a
// SignPath signing policy, by running `csi-codesign macos sign`
// (https://github.com/eclipse-csi/codesign-tools), then notarizes them with
// `csi-codesign macos notarize` when asked to.
//
// Dependency-free, like the action at the root of this repository. The two commands run with
// separate credentials: signing gets the SignPath API token only, notarization the App Store
// Connect API key only.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const core = require('../lib/core.js');
const { installCli } = require('../lib/install.js');
const CHECKSUMS = require('../checksums.json');

const { ActionError, getBooleanInput, getInput, mask, parseSeconds } = core;

// The first release with the `macos` commands.
const MIN_CLI_VERSION = '0.12.0';

// Credentials of the job that neither command uses: they upload and download workflow artifacts.
const UNUSED_RUNNER_ENV = ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL'];

const API_TOKEN_ENV = 'CSI_CODESIGN_API_TOKEN';
const NOTARY_KEY_ENV = 'CSI_CODESIGN_NOTARY_KEY';
const NOTARY_KEY_ID_ENV = 'CSI_CODESIGN_NOTARY_KEY_ID';
const NOTARY_ISSUER_ENV = 'CSI_CODESIGN_NOTARY_ISSUER';
const CREDENTIALS_ENV = [API_TOKEN_ENV, NOTARY_KEY_ENV, NOTARY_KEY_ID_ENV, NOTARY_ISSUER_ENV];

// --- Inputs ------------------------------------------------------------------------------------

/** Compares two `x.y.z` versions. */
function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Fails for the csi-codesign versions the action knows that have no `macos` commands. */
function checkCliVersion(version, checksums = CHECKSUMS) {
  // Other unknown versions are left to the installation, which lists the known ones.
  if (Object.hasOwn(checksums.versions, version) && compareVersions(version, MIN_CLI_VERSION) < 0) {
    throw new ActionError(
      `csi-codesign ${version} cannot sign for macOS: this action needs csi-codesign ` +
        `${MIN_CLI_VERSION} or later.`,
    );
  }
}

/**
 * The App Store Connect API key as the PEM document csi-codesign expects, from the content of
 * the .p8 file or from its base64 encoding, which is how such keys are often stored in secrets.
 */
function normalizeNotaryKey(value) {
  let key = value.trim();
  if (!key.includes('-----BEGIN')) {
    const compact = key.replace(/\s+/g, '');
    const decoded = /^[A-Za-z0-9+/]+={0,2}$/.test(compact)
      ? Buffer.from(compact, 'base64').toString('utf8')
      : '';
    if (!decoded.includes('-----BEGIN')) {
      throw new ActionError(
        'Input "notary-key" must be the content of the App Store Connect API key (.p8 file), or ' +
          'its base64 encoding.',
      );
    }
    key = decoded.trim();
  }
  return `${key}\n`;
}

function isFile(file) {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}

function parseSha256(name, value) {
  if (value !== '' && !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new ActionError(`Input "${name}" must be a SHA-256 in hexadecimal (64 characters).`);
  }
  return value;
}

/** Reads the notarization inputs, or returns null when the files are not to be notarized. */
function readNotaryInputs(env) {
  if (!getBooleanInput('notarize', env)) {
    return null;
  }
  const rawKey = getInput('notary-key', {}, env);
  mask(rawKey);
  const keyId = getInput('notary-key-id', {}, env);
  if (!rawKey || !keyId) {
    throw new ActionError(
      'Inputs "notary-key" and "notary-key-id" are required when "notarize" is true.',
    );
  }
  const key = normalizeNotaryKey(rawKey);
  // The decoded key is not the secret the runner knows: mask it too.
  mask(key.trim());
  return {
    key,
    keyId,
    issuer: getInput('notary-issuer', {}, env),
    timeout: parseSeconds('notarize-timeout', getInput('notarize-timeout', {}, env)),
    staple: getBooleanInput('staple', env, true),
  };
}

// --- Signing and notarization ------------------------------------------------------------------

function buildSignArgs({
  organizationId,
  projectId,
  signingPolicy,
  identity = '',
  installerIdentity = '',
  entitlements = '',
  identityTimeout = '',
  signingTimeout = '',
  ctkSha256 = '',
  outputDir = '',
  verbose = false,
  files,
}) {
  return [
    'macos',
    'sign',
    '--organization-id',
    organizationId,
    '--project-id',
    projectId,
    '--signing-policy',
    signingPolicy,
    ...(identity ? ['--identity', identity] : []),
    ...(installerIdentity ? ['--installer-identity', installerIdentity] : []),
    ...(entitlements ? ['--entitlements', entitlements] : []),
    ...(identityTimeout ? ['--identity-timeout', identityTimeout] : []),
    ...(signingTimeout ? ['--signing-timeout', signingTimeout] : []),
    ...(ctkSha256 ? ['--ctk-sha256', ctkSha256] : []),
    // Without an output directory, the inputs are signed in place, which --force-overwrite
    // allows. With one, it lets a re-run replace the copies of the previous attempt.
    ...(outputDir ? ['--output-dir', outputDir] : []),
    '--force-overwrite',
    ...(verbose ? ['--verbose'] : []),
    '--',
    ...files,
  ];
}

function buildNotarizeArgs({ timeout = '', staple = true, verbose = false, files }) {
  return [
    'macos',
    'notarize',
    ...(timeout ? ['--wait-for-completion-timeout', timeout] : []),
    ...(staple ? [] : ['--no-staple']),
    ...(verbose ? ['--verbose'] : []),
    '--',
    ...files,
  ];
}

/**
 * The environment of `macos sign`: the runner's, minus the action inputs, the credentials of the
 * job that signing does not need and any notarization credentials, plus the SignPath API token.
 */
function signEnv(env, apiToken) {
  const result = core.baseEnv(env, [...UNUSED_RUNNER_ENV, ...CREDENTIALS_ENV]);
  result[API_TOKEN_ENV] = apiToken;
  return result;
}

/** The environment of `macos notarize`: as above, with the App Store Connect API key instead. */
function notarizeEnv(env, { key, keyId, issuer = '' }) {
  const result = core.baseEnv(env, [...UNUSED_RUNNER_ENV, ...CREDENTIALS_ENV]);
  result[NOTARY_KEY_ENV] = key;
  result[NOTARY_KEY_ID_ENV] = keyId;
  if (issuer) {
    result[NOTARY_ISSUER_ENV] = issuer;
  }
  return result;
}

function list(paths) {
  return paths.map((file) => `  ${file}`).join('\n');
}

async function run(env = process.env, dependencies = {}) {
  const {
    installer = installCli,
    cwd = process.cwd(),
    platform = process.platform,
    checksums = CHECKSUMS,
  } = dependencies;

  const apiToken = getInput('api-token', { required: true }, env);
  mask(apiToken);
  const notary = readNotaryInputs(env);

  if (platform !== 'darwin') {
    throw new ActionError(
      'This action runs on macOS runners only: it signs with codesign and productsign.',
    );
  }
  const version = getInput('cli-version', {}, env) || checksums.default;
  checkCliVersion(version, checksums);

  const outputDir = getInput('output-dir', {}, env);
  const verbose = getBooleanInput('verbose', env) || env.RUNNER_DEBUG === '1';
  const options = {
    organizationId: getInput('organization-id', { required: true }, env),
    projectId: getInput('project-id', { required: true }, env),
    signingPolicy: getInput('signing-policy', { required: true }, env),
    identity: getInput('identity', {}, env),
    installerIdentity: getInput('installer-identity', {}, env),
    entitlements: getInput('entitlements', {}, env),
    identityTimeout: parseSeconds('identity-timeout', getInput('identity-timeout', {}, env)),
    signingTimeout: parseSeconds('signing-timeout', getInput('signing-timeout', {}, env)),
    ctkSha256: parseSha256('ctk-sha256', getInput('ctk-sha256', {}, env)),
    outputDir,
    verbose,
  };
  if (options.entitlements && !isFile(path.resolve(cwd, options.entitlements))) {
    throw new ActionError(
      `The entitlements file "${options.entitlements}" does not exist (relative to ${cwd}).`,
    );
  }

  // Bundles are directories. The order is kept: csi-codesign signs in the order given.
  const files = core.expandFiles(getInput('files', { required: true }, env), cwd, {
    directories: true,
    sort: false,
  });
  if (outputDir) {
    core.checkDistinctNames(
      files,
      'The inputs are copied to the output directory under their names, which must be distinct',
    );
  }
  const signed = core.signedPaths(files, outputDir);

  console.log(`::group::Install csi-codesign ${version}`);
  let cli;
  try {
    cli = await installer(version);
  } finally {
    console.log('::endgroup::');
  }

  console.log(`Signing:\n${list(files)}`);
  core.runCli(cli, buildSignArgs({ ...options, files }), signEnv(env, apiToken), { cwd });
  core.setOutput('signed-files', signed.join('\n'), env);

  if (notary) {
    console.log(`Notarizing:\n${list(signed)}`);
    core.runCli(
      cli,
      buildNotarizeArgs({ ...notary, verbose, files: signed }),
      notarizeEnv(env, notary),
      { cwd },
    );
  } else {
    console.log('Not notarizing: the "notarize" input is not true.');
  }
}

module.exports = {
  MIN_CLI_VERSION,
  buildNotarizeArgs,
  buildSignArgs,
  checkCliVersion,
  compareVersions,
  normalizeNotaryKey,
  notarizeEnv,
  readNotaryInputs,
  run,
  signEnv,
};

if (require.main === module) {
  core.main(run);
}
