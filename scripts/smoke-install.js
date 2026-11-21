// Copyright (c) 2026 Eclipse Foundation AISBL and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License 2.0 which is available at
// https://www.eclipse.org/legal/epl-2.0/
//
// SPDX-License-Identifier: EPL-2.0

// Installs a real csi-codesign release the way the action does (download, checksum, extraction)
// and runs `csi-codesign --version`. Needs network access, but no SignPath credentials.
//
//   node scripts/smoke-install.js [version] [extra csi-codesign arguments...]
'use strict';

const childProcess = require('node:child_process');
const { installCli } = require('../index.js');
const checksums = require('../checksums.json');

async function main() {
  const [version = checksums.default, ...extraArgs] = process.argv.slice(2);
  const cli = await installCli(version);
  const output = childProcess.execFileSync(cli, [...extraArgs, '--version'], { encoding: 'utf8' });
  process.stdout.write(output);
  if (!output.includes(version)) {
    throw new Error(`csi-codesign --version does not mention ${version}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
