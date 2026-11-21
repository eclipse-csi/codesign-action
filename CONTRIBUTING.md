# Contributing to Eclipse CSI Codesign Action

Thanks for your interest in this project. It is part of the
[Eclipse Common Security Infrastructure (CSI)](https://projects.eclipse.org/projects/technology.csi)
project.

## Eclipse Contributor Agreement

Before your contribution can be accepted, you must electronically sign the
[Eclipse Contributor Agreement (ECA)](https://www.eclipse.org/legal/ECA.php).

## Development

The action is a single dependency-free script, [`index.js`](index.js), run by the `node24`
runtime of GitHub Actions. Keep it dependency-free: a dependency would need a bundled `dist/`
and would add an npm supply chain to every workflow that signs with this action.

```bash
node --test                      # unit tests (Node.js 24 or later)
node scripts/smoke-install.js    # downloads, verifies and runs the pinned csi-codesign
prek install                     # git hooks, see prek.toml
```

The [Live test](.github/workflows/live-test.yml) workflow signs jars through SignPath with the
action itself. It needs the `SIGNPATH_API_TOKEN` secret and the repository variables listed at
the top of the workflow.

## Updating csi-codesign

The [Update csi-codesign](.github/workflows/update-cli.yml) workflow checks for new
codesign-tools releases daily, and opens a pull request that adds the new version to
`checksums.json` and makes it the default. To do it by hand:

```bash
GH_TOKEN=... node scripts/update-checksums.js 0.11.0
```

Never edit the checksums by hand: the script only records an archive once its build provenance
passes `gh attestation verify`.

Pull requests opened with `GITHUB_TOKEN` do not trigger workflows. Close and reopen the pull
request, or push to its branch, to run the CI before merging.

## Releasing

1. Make sure the CI and the live test pass on `main`.
2. Tag the release with a signed tag, e.g. `git tag -s v1.2.0 -m v1.2.0`, and push it.
3. Move the major version tag: `git tag -fs v1 -m v1.2.0 v1.2.0^{}` and
   `git push -f origin v1`.
4. Create a GitHub release for `v1.2.0`. It lists the default `csi-codesign` version.

## Contact

Contact the project developers through the
[CSI project page](https://projects.eclipse.org/projects/technology.csi).
