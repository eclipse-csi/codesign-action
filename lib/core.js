// Copyright (c) 2026 Eclipse Foundation AISBL and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License 2.0 which is available at
// https://www.eclipse.org/legal/epl-2.0/
//
// SPDX-License-Identifier: EPL-2.0

// What the actions of this repository share: workflow commands, input parsing, and running
// csi-codesign. Dependency-free, like everything the actions load.
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Credentials the runner gives a JavaScript action that csi-codesign has no use for.
const OIDC_ENV = ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'];

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

/** Reads a `true` or `false` input; `fallback` is its value when the input is empty. */
function getBooleanInput(name, env = process.env, fallback = false) {
  const value = getInput(name, {}, env).toLowerCase();
  if (value === '') {
    return fallback;
  }
  if (value === 'false') {
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

/** Orders strings by UTF-16 code units, as `sort()` does by default, whatever the locale. */
function byCodeUnit(a, b) {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function stats(file) {
  // A broken symbolic link has no stats; it is not something to sign.
  return fs.statSync(file, { throwIfNoEntry: false });
}

/**
 * Expands the `files` input (one path or glob per line) into the list of files to sign, relative
 * to `cwd` unless a pattern is absolute. Every pattern must match at least one regular file.
 *
 * With `directories`, a pattern may also match directories, such as macOS bundles. The result is
 * sorted, unless `sort` is false: then it follows the order of the patterns, each pattern's
 * matches being sorted.
 */
function expandFiles(spec, cwd = process.cwd(), { directories = false, sort = true } = {}) {
  const patterns = lines(spec);
  if (patterns.length === 0) {
    throw new ActionError('No files to sign: the "files" input is empty.');
  }
  const accepts = (file) => {
    const found = stats(file);
    return found !== undefined && (found.isFile() || (directories && found.isDirectory()));
  };
  // A pattern that names a directory may end with a separator, which is not part of its name.
  const clean = (match) => (directories ? match.replace(/(?<=[^\\/])[\\/]+$/, '') : match);
  const files = new Map();
  for (const pattern of patterns) {
    const matches = fs
      .globSync(pattern, { cwd })
      .map((match) => clean(path.normalize(match)))
      .filter((match) => accepts(path.resolve(cwd, match)))
      .sort(byCodeUnit);
    if (matches.length === 0) {
      throw new ActionError(
        `No ${directories ? 'file or directory' : 'file'} matches "${pattern}" (relative to ${cwd}).`,
      );
    }
    for (const match of matches) {
      // A file matched again keeps its place in the list.
      files.set(path.resolve(cwd, match), match);
    }
  }
  const result = [...files.values()];
  return sort ? result.sort(byCodeUnit) : result;
}

/**
 * Fails when two files have the same name: `reason` says why the names must differ. Checked by
 * the actions to fail before the CLI is even downloaded.
 */
function checkDistinctNames(files, reason) {
  const seen = new Map();
  for (const file of files) {
    const name = path.basename(file);
    if (seen.has(name)) {
      throw new ActionError(
        `"${seen.get(name)}" and "${file}" have the same file name. ${reason}; sign them in ` +
          'separate steps instead.',
      );
    }
    seen.set(name, file);
  }
}

/** Checks an optional input that is a positive number of seconds. */
function parseSeconds(name, value) {
  if (value === '') {
    return '';
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ActionError(`Input "${name}" must be a positive number of seconds, got "${value}".`);
  }
  return value;
}

/** Where csi-codesign writes each signed file. */
function signedPaths(files, outputDir) {
  return outputDir ? files.map((file) => path.join(outputDir, path.basename(file))) : files;
}

// --- csi-codesign ------------------------------------------------------------------------------

/**
 * The environment to start csi-codesign from: the runner's, minus the action inputs (secrets are
 * among them), the OIDC request credentials and the variables named by `strip`.
 */
function baseEnv(env, strip = []) {
  const dropped = new Set([...OIDC_ENV, ...strip]);
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (!upper.startsWith('INPUT_') && !dropped.has(upper)) {
      result[name] = value;
    }
  }
  return result;
}

/** Runs csi-codesign, with its output in the job log. Fails unless it exits with 0. */
function runCli(cli, args, env, { cwd } = {}) {
  const result = childProcess.spawnSync(cli, args, { stdio: 'inherit', env, cwd });
  if (result.error) {
    throw new Error(`Could not run ${cli}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    // csi-codesign has already printed why.
    throw new ActionError(
      `csi-codesign failed (exit code ${result.status ?? `signal ${result.signal}`}).`,
    );
  }
}

/** Runs an action, and reports its failure as the error of the step. */
function main(run) {
  return run().catch((error) => {
    const message = error instanceof ActionError ? error.message : error.stack || String(error);
    console.log(`::error::${escapeData(message)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ActionError,
  baseEnv,
  checkDistinctNames,
  escapeData,
  expandFiles,
  getBooleanInput,
  getInput,
  lines,
  main,
  mask,
  parseSeconds,
  runCli,
  setOutput,
  signedPaths,
};
