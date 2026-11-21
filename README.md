# Eclipse CSI Codesign Action

Signs files in a GitHub Actions workflow with [SignPath](https://about.signpath.io/), through
SignPath's [GitHub trusted build system](https://docs.signpath.io/trusted-build-systems/github).

Eclipse Foundation signing policies use **trusted build system verification**: SignPath rejects
files uploaded directly to its API, and only signs files it fetched from GitHub itself, after
checking which repository, workflow and branch built them. This action does that in one step.
It runs [`csi-codesign`](https://github.com/eclipse-csi/codesign-tools) in `github-actions`
submission mode:

1. It downloads the `csi-codesign` release pinned by this version of the action, and checks the
   download against the SHA-256 recorded in [`checksums.json`](checksums.json).
2. It stores the files as an artifact of the running job, and submits it to SignPath in one
   signing request.
3. It waits for the request to complete, then writes the signed files in place, or to
   `output-dir`.

## Usage

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      actions: read   # SignPath downloads the files to sign, a workflow artifact, with GITHUB_TOKEN
      contents: read
    steps:
      # ... check out and build ...

      - name: Sign
        uses: eclipse-csi/codesign-action@<commit-sha> # v1
        with:
          files: dist/app.exe
          organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
          project-id: technology.example
          signing-policy: release-signing
          artifact-configuration: pe-file
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}

      # dist/app.exe is now signed.
```

Pin the action to a full commit SHA, with the version in a comment, so that Dependabot can
update it.

### Several files

Several files are signed in **one** request: they are packed at the root of a zip file, so the
artifact configuration must have a `<zip-file>` root element, and the files must have distinct
names. A policy that requires approval then asks for a single approval.

```yaml
      - uses: eclipse-csi/codesign-action@<commit-sha> # v1
        with:
          files: |
            dist/*.exe
            dist/*.dll
          output-dir: signed
          organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
          project-id: technology.example
          signing-policy: release-signing
          artifact-configuration: windows-binaries-in-zip
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
```

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="*.exe"><authenticode-sign /></pe-file>
    <pe-file path="*.dll"><authenticode-sign /></pe-file>
  </zip-file>
</artifact-configuration>
```

To sign files with different artifact configurations or signing policies, use one step per
set of files.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `files` | yes | Files to sign, one path or glob per line, relative to the workspace. Each line must match at least one file. Lines starting with `#` are ignored. |
| `organization-id` | yes | SignPath organization ID. |
| `project-id` | yes | SignPath project slug. |
| `signing-policy` | yes | SignPath signing policy slug, e.g. `test-signing` or `release-signing`. |
| `api-token` | yes | API token of the SignPath CI user. Pass it from a secret. |
| `artifact-configuration` | no | SignPath artifact configuration slug. Defaults to the project's default configuration. |
| `output-dir` | no | Directory to write the signed files to, under their original names. When empty (the default), the files are signed in place. |
| `params` | no | User-defined parameters of the artifact configuration, one `key=value` per line. SignPath ignores parameters the configuration does not declare. |
| `timeout` | no | Seconds to wait for the request to complete, e.g. while it waits for approval. Defaults to 600. |
| `github-token` | no | Token SignPath reads the workflow run and downloads the artifact with. Defaults to `github.token`, which needs the `actions: read` permission. |
| `cli-version` | no | `csi-codesign` version to run. Defaults to the version this release of the action was verified with. Only versions listed in `checksums.json` are accepted. |
| `verbose` | no | `true` to make `csi-codesign` verbose. Also on when the job runs with debug logging. |

## Outputs

| Output | Description |
| --- | --- |
| `signed-files` | Paths of the signed files, one per line. |

## Requirements and limitations

- **Runners:** Linux x64 and arm64, macOS arm64, Windows x64 (the platforms `csi-codesign` is
  released for). Self-hosted runners need `tar` on the `PATH` (Windows: `%SystemRoot%\System32\tar.exe`).
- **Permissions:** the job needs `actions: read`.
- **Origin verification:** the signing policy decides which repositories, branches and tags may
  sign. If SignPath rejects the request, the log lists each policy violation with SignPath's hint
  on how to fix it.
- **Unique file names within a workflow run:** a single file is uploaded as an artifact named
  after the file, and artifact names must be unique within a run, even across jobs. A matrix
  that signs `app.exe` on several runners has to give the files different names.
- **Re-runs:** SignPath rejects a workflow run after 3 re-runs ("Too many workflow reruns").
  Start a new run instead.
- **Not covered:** Apple code signing and notarization, which SignPath does not provide.

Maven builds can sign in the build itself with
[`codesign-maven-plugin`](https://github.com/eclipse-csi/codesign-tools/blob/main/USAGE.md#github-actions-trusted-build-system)
instead.

## Security

- The action is a dependency-free JavaScript action: there is no bundled code and no npm
  dependency to trust. Review [`index.js`](index.js) and [`action.yml`](action.yml).
- `csi-codesign` is downloaded from the
  [codesign-tools releases](https://github.com/eclipse-csi/codesign-tools/releases) and checked
  against the SHA-256 in `checksums.json` before it runs. A checksum is only added to that file
  once the archive passes `gh attestation verify`: its build provenance must show that the
  codesign-tools release workflow built it from the version's tag (see
  [`scripts/update-checksums.js`](scripts/update-checksums.js)).
- The verified archive is cached in the runner's tool cache, but it is verified again and
  extracted anew on every use.
- The job's Actions runtime token, which uploads the artifact, is only given to the
  `csi-codesign` process. It never becomes a step output or an environment variable of later
  steps. The OIDC token request credentials and the action inputs are not passed to it.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[Eclipse Public License - v 2.0](LICENSE)
