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

macOS apps, binaries, disk images and installer packages are signed, and notarized, by a second
action of this repository, `eclipse-csi/codesign-action/macos`: see
[macOS: sign and notarize](#macos-sign-and-notarize).

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

## macOS: sign and notarize

`eclipse-csi/codesign-action/macos` signs macOS apps and other bundles, Mach-O binaries, disk
images and installer packages with the Developer ID certificate of a SignPath signing policy,
and notarizes them with Apple when asked to. It runs on a macOS runner:

1. It installs `csi-codesign` the same way, checked against `checksums.json`.
2. It runs [`csi-codesign macos sign`](https://github.com/eclipse-csi/codesign-tools/blob/main/USAGE.md#macos-sign-and-notarize),
   which signs with `codesign` and `productsign` through the
   [SignPath macOS CryptoTokenKit](https://docs.signpath.io/crypto-providers/macos): bundles
   from the inside out, with the hardened runtime and a secure timestamp. Every signature is
   verified.
3. With `notarize: true`, it runs `csi-codesign macos notarize` on what it just signed: Apple's
   notary service checks each file, the ticket is stapled to it, and Gatekeeper must accept the
   result.

```yaml
jobs:
  build:
    runs-on: macos-latest
    permissions:
      contents: read
    steps:
      # ... check out and build build/MyApp.app, unsigned ...

      - name: Sign the app
        uses: eclipse-csi/codesign-action/macos@<commit-sha> # v1
        with:
          files: build/MyApp.app
          output-dir: signed
          organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
          project-id: technology.example
          signing-policy: apple-application-release
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}

      - name: Create the disk image
        run: hdiutil create -format UDZO -srcfolder signed/MyApp.app signed/MyApp.dmg

      # Notarization covers the app inside the disk image; the ticket is stapled to the image.
      - name: Sign and notarize the disk image
        uses: eclipse-csi/codesign-action/macos@<commit-sha> # v1
        with:
          files: signed/MyApp.dmg
          organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
          project-id: technology.example
          signing-policy: apple-application-release
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
          notarize: true
          notary-key: ${{ secrets.APPLE_NOTARY_KEY }}
          notary-key-id: ${{ secrets.APPLE_NOTARY_KEY_ID }}
          notary-issuer: ${{ secrets.APPLE_NOTARY_ISSUER }}
```

A signing policy has a single certificate. Installer packages (`.pkg`) need the *Developer ID
Installer* certificate, so sign them in their own step, with the signing policy that holds it.

### macOS inputs

| Input | Required | Description |
| --- | --- | --- |
| `files` | yes | What to sign, one path or glob per line, relative to the workspace: bundles (`.app`, `.framework`, ...), Mach-O binaries, disk images (`.dmg`) or installer packages (`.pkg`). Each line must match at least one file or directory. They are signed in the order given. Lines starting with `#` are ignored. |
| `organization-id` | yes | SignPath organization ID. |
| `project-id` | yes | SignPath project slug. |
| `signing-policy` | yes | SignPath signing policy slug. |
| `api-token` | yes | API token of the SignPath CI user. Pass it from a secret. |
| `identity` | no | Code signing identity (Developer ID Application certificate): a part of its name, or its SHA-1 hash. Defaults to the certificate of the signing policy. |
| `installer-identity` | no | The same for `.pkg` files (Developer ID Installer certificate). |
| `entitlements` | no | Entitlements file of the top-level bundles and binaries. Nested code is signed without entitlements. |
| `output-dir` | no | Directory to copy the inputs to before signing them, under their original names. When empty (the default), they are signed in place. |
| `notarize` | no | `true` to notarize the signed files, staple the tickets and check them with Gatekeeper. Defaults to `false`. |
| `notary-key` | with `notarize` | App Store Connect API private key: the content of the `.p8` file, or its base64 encoding. Pass it from a secret. |
| `notary-key-id` | with `notarize` | App Store Connect API key ID. |
| `notary-issuer` | no | App Store Connect API issuer ID. Team keys need it, individual keys do not. |
| `staple` | no | `false` to notarize without stapling the tickets. Defaults to `true`. |
| `notarize-timeout` | no | Seconds to wait for Apple to process each submission. Defaults to 1800. |
| `identity-timeout` | no | Seconds to wait for the CryptoTokenKit to publish the signing identity. Defaults to 60. |
| `signing-timeout` | no | Seconds each `codesign` or `productsign` call may take. Defaults to 300. |
| `ctk-sha256` | no | Expected SHA-256 of the SignPath CryptoTokenKit disk image that `csi-codesign` downloads. Its Developer ID signature by SignPath GmbH is checked in any case. |
| `cli-version` | no | `csi-codesign` version to run, 0.12.0 or later. Defaults to the version this release of the action was verified with. |
| `verbose` | no | `true` to show each `codesign` and `notarytool` invocation. Also on when the job runs with debug logging. |

The only output is `signed-files`: the paths of the signed files and bundles, one per line. It
is set as soon as signing succeeds, even if notarization then fails.

### macOS requirements and limitations

- **Runners:** macOS on Apple Silicon (e.g. `macos-latest`), with the Xcode command line tools.
- **SignPath project:** its *default* artifact configuration must be of type *hash signing
  data*. The CryptoTokenKit always uses the default configuration. File-based configurations
  can live in the same project: the main action selects them with `artifact-configuration`.
- **Signing policy:** it must have neither trusted build system verification nor origin
  verification, unlike the policies the main action signs with: SignPath refuses hash signing
  under such policies. The job therefore needs no `actions: read` permission.
- **Notarization** needs an App Store Connect API key of the Apple developer team that owns the
  certificates. Apple ID passwords are not supported. Without `notarize: true`, the notarization
  inputs are ignored, so `notarize` can be an expression, e.g. to notarize releases only.
- **What gets notarized** is what the step signed. To notarize an app, sign it, then sign and
  notarize the disk image or the package that carries it. A bare Mach-O binary can be notarized
  too, but Apple cannot staple a ticket to it.

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
- **Apple formats:** SignPath has no artifact configuration for apps, Mach-O binaries, disk
  images or installer packages. Sign them with the [macOS action](#macos-sign-and-notarize).

Maven builds can sign in the build itself with
[`codesign-maven-plugin`](https://github.com/eclipse-csi/codesign-tools/blob/main/USAGE.md#github-actions-trusted-build-system)
instead.

## Security

- Both actions are dependency-free JavaScript actions: there is no bundled code and no npm
  dependency to trust. Review [`index.js`](index.js), [`macos/index.js`](macos/index.js), the
  code they share in [`lib/`](lib/), and the two `action.yml` files.
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
- The macOS action keeps its two sets of credentials apart: `csi-codesign macos sign` gets the
  SignPath API token only, `csi-codesign macos notarize` the App Store Connect API key only.
  Neither gets the Actions runtime token or the OIDC token request credentials, and no secret
  is passed on a command line.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[Eclipse Public License - v 2.0](LICENSE)
