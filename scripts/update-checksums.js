// Copyright (c) 2026 Eclipse Foundation AISBL and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License 2.0 which is available at
// https://www.eclipse.org/legal/epl-2.0/
//
// SPDX-License-Identifier: EPL-2.0

// Adds a csi-codesign release to checksums.json and makes it the default version.
//
//   node scripts/update-checksums.js [version]
//
// Without a version, takes the latest release of eclipse-csi/codesign-tools. Each platform
// archive is downloaded and must pass `gh attestation verify`: its build provenance must say that
// the release workflow of eclipse-csi/codesign-tools built it from the version's tag. Its SHA-256
// must also match the release's checksums_sha256.txt. Only then is the checksum recorded.
//
// Needs the GitHub CLI (`gh`), authenticated through GH_TOKEN. Writes `version` and `updated`
// to GITHUB_OUTPUT when it is set.
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PLATFORMS, RELEASES_URL, download, sha256File, setOutput } = require('../index.js');

const REPO = 'eclipse-csi/codesign-tools';
const SIGNER_WORKFLOW = `${REPO}/.github/workflows/release.yml`;
const CHECKSUMS_FILE = path.join(__dirname, '..', 'checksums.json');

async function latestVersion() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
  if (!response.ok) {
    throw new Error(`Could not read the latest release of ${REPO}: HTTP ${response.status}`);
  }
  const { tag_name: tag } = await response.json();
  return tag.replace(/^v/, '');
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} answered HTTP ${response.status}`);
  }
  return response.text();
}

/** Parses a `<sha256>  <file name>` listing. */
function parseChecksums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) {
      sums.set(match[2], match[1]);
    }
  }
  return sums;
}

function verifyAttestation(file, version) {
  childProcess.execFileSync(
    'gh',
    [
      'attestation',
      'verify',
      file,
      '--repo',
      REPO,
      '--signer-workflow',
      SIGNER_WORKFLOW,
      '--source-ref',
      `refs/tags/v${version}`,
    ],
    { stdio: 'inherit' },
  );
}

async function main() {
  const version = process.argv[2] || (await latestVersion());
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error(`Unexpected version "${version}"`);
  }
  const checksums = JSON.parse(fs.readFileSync(CHECKSUMS_FILE, 'utf8'));
  if (checksums.default === version && checksums.versions[version]) {
    console.log(`csi-codesign ${version} is already the default version.`);
    if (process.env.GITHUB_OUTPUT) {
      setOutput('version', version);
      setOutput('updated', 'false');
    }
    return;
  }

  const published = parseChecksums(
    await fetchText(`${RELEASES_URL}/v${version}/checksums_sha256.txt`),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csi-codesign-checksums-'));
  const sums = {};
  try {
    for (const suffix of Object.values(PLATFORMS)) {
      const archive = `csi-codesign-${version}-${suffix}.${suffix.startsWith('windows') ? 'zip' : 'tar.gz'}`;
      const file = path.join(dir, archive);
      console.log(`Downloading ${archive}`);
      await download(`${RELEASES_URL}/v${version}/${archive}`, file);
      verifyAttestation(file, version);
      const sha256 = await sha256File(file);
      if (published.get(archive) !== sha256) {
        throw new Error(
          `SHA-256 of ${archive} (${sha256}) differs from checksums_sha256.txt (${published.get(archive)})`,
        );
      }
      sums[suffix] = sha256;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  checksums.versions = { [version]: sums, ...checksums.versions };
  checksums.default = version;
  fs.writeFileSync(CHECKSUMS_FILE, `${JSON.stringify(checksums, null, 2)}\n`);
  console.log(`checksums.json now defaults to csi-codesign ${version}.`);
  if (process.env.GITHUB_OUTPUT) {
    setOutput('version', version);
    setOutput('updated', 'true');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
