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

const core = require('./lib/core.js');
const install = require('./lib/install.js');
const CHECKSUMS = require('./checksums.json');

const { ActionError, getBooleanInput, getInput, mask, setOutput, signedPaths } = core;

// Variables the github-actions submission mode needs, on top of the two tokens.
const REQUIRED_RUNNER_ENV = [
  'ACTIONS_RESULTS_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'GITHUB_RUN_ID',
  'GITHUB_REPOSITORY',
];

// --- Inputs ------------------------------------------------------------------------------------

/**
 * Several files are signed together as one zip, at its root, so their names must differ. Checked
 * here to fail before the CLI is even downloaded.
 */
function checkDistinctNames(files) {
  core.checkDistinctNames(
    files,
    'Files signed together are packed at the root of one zip, so their names must be distinct',
  );
}

/** Parses the `params` input: one `key=value` per line. */
function parseParams(spec) {
  return core.lines(spec).map((line) => {
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new ActionError(`Invalid "params" line "${line}": expected key=value.`);
    }
    return line;
  });
}

function parseTimeout(value) {
  return core.parseSeconds('timeout', value);
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
  const result = core.baseEnv(env);
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

  const files = core.expandFiles(getInput('files', { required: true }, env), process.cwd());
  checkDistinctNames(files);
  const spawnEnv = childEnv(env, apiToken, githubToken);

  console.log(`::group::Install csi-codesign ${version}`);
  let cli;
  try {
    cli = await install.installCli(version);
  } finally {
    console.log('::endgroup::');
  }

  console.log(
    `Signing ${files.length === 1 ? '1 file' : `${files.length} files in one request`}:\n` +
      files.map((file) => `  ${file}`).join('\n'),
  );
  core.runCli(cli, buildArgs({ ...options, files }), spawnEnv);
  setOutput('signed-files', signedPaths(files, outputDir).join('\n'), env);
}

module.exports = {
  ActionError,
  PLATFORMS: install.PLATFORMS,
  RELEASES_URL: install.RELEASES_URL,
  buildArgs,
  checkDistinctNames,
  childEnv,
  download: install.download,
  expandFiles: core.expandFiles,
  extractCommand: install.extractCommand,
  getBooleanInput,
  getInput,
  installCli: install.installCli,
  parseParams,
  parseTimeout,
  resolveAsset: install.resolveAsset,
  run,
  setOutput,
  sha256File: install.sha256File,
  signedPaths,
};

if (require.main === module) {
  core.main(run);
}
