# Release Process

Use GitHub Actions for desktop releases.

Normal development stays on Windows.
GitHub builds Windows, macOS, and Linux for release tags.
macOS signing and notarization happen in GitHub Actions.

Future AI agents should also read `docs/AI_RELEASE_HANDOFF.md` before release work.

## One-Time Setup

- Keep the release workflow on `main`: `.github/workflows/release.yml`
- Keep the required repository secrets set in GitHub Actions
- For secret names and setup details, read `docs/CI_SECRETS.md`

## Normal Release

1. Update the version in `package.json`.
2. Update the release notes doc for that version.
3. Commit and push the release changes to `main`.
4. Create and push the release tag:

```bash
git tag v0.1.12
git push origin v0.1.12
```

5. Open `Actions > Release Desktop Builds`.
6. Wait for all jobs to turn green.
7. Open the draft release GitHub created.
8. Replace the draft text with the real release notes.
9. Verify the uploaded assets:
   - `Windows Installer`
   - `Windows Portable`
   - `Mac (Apple Silicon)`
   - `Mac (Intel)`
   - `Linux AppImage`
   - `Linux deb`
10. Publish the release.

## What The Workflow Uploads

The workflow uploads only the user-facing desktop downloads:

- Windows installer `.exe`
- Windows portable `.exe`
- macOS Apple Silicon `.dmg`
- macOS Intel `.dmg`
- Linux AppImage `.AppImage`
- Linux Debian package `.deb`

It does not upload `.blockmap` or `latest*.yml` files.

## Safe Test Run

If you want to test the workflow without touching a real release, use a throwaway tag:

```bash
git tag -a v0.1.11-ci-test -m "Test GitHub Actions release workflow"
git push origin refs/tags/v0.1.11-ci-test
```

Then watch the Actions run and inspect the draft release GitHub creates.

## Clean Up A Test Run

1. Delete the test release on GitHub.
2. Delete the remote test tag:

```bash
git push origin :refs/tags/v0.1.11-ci-test
```

3. Delete the local test tag:

```bash
git tag -d v0.1.11-ci-test
```

## If A Release Fails

- If Windows fails, open the failed job and read the last step first.
- If macOS fails, check secrets and notarization first.
- For macOS secrets and troubleshooting, read `docs/CI_SECRETS.md`.

## Rules

- Do not commit secrets, certificates, `.p12` files, passwords, or API keys.
- Do not invent a different Mac release flow unless the user asks for it.
- For release work, prefer the GitHub Actions workflow over manual local packaging.
