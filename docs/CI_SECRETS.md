# CI Secrets And Release Flow

This repo now supports a Windows-first release flow:

1. Do normal development on Windows.
2. Bump the app version and push a release tag.
3. Let GitHub Actions build Windows artifacts on `windows-latest`.
4. Let GitHub Actions build, sign, and notarize macOS artifacts on `macos-latest`.
5. Review the draft release, polish the notes, and publish it.

## What The Workflow Publishes

The release workflow uploads only the user-facing desktop artifacts:

- `Windows Installer`
- `Windows Portable`
- `Mac (Apple Silicon)`
- `Mac (Intel)`

It intentionally does **not** upload `.blockmap` or `latest*.yml` files right now because the app does not currently use `electron-updater` / `autoUpdater`.

GitHub still adds `Source code (zip)` and `Source code (tar.gz)` automatically.

## Required GitHub Secrets

Add these repository secrets in `Settings > Secrets and variables > Actions`:

- `CSC_LINK`
  Base64-encoded `Developer ID Application` certificate exported as a `.p12` file.
- `CSC_KEY_PASSWORD`
  Password used when exporting that `.p12` certificate.
- `APPLE_ID`
  Apple ID email for the Apple Developer account used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`
  App-specific password from `appleid.apple.com`.
- `APPLE_TEAM_ID`
  Apple Developer Team ID used for notarization.

`GITHUB_TOKEN` is provided automatically by GitHub Actions. No extra GitHub secret is needed for release uploads.

## Export The macOS Signing Certificate

On the Mac that already has a working signing identity:

1. Open `Keychain Access`.
2. Find the `Developer ID Application` certificate for the Velorn team.
3. Export it as a `.p12` file.
4. Set a password during export.
5. Base64-encode the `.p12` and store that result in the `CSC_LINK` GitHub secret.

Example on macOS:

```bash
base64 -i "/path/to/DeveloperIDApplication.p12" | pbcopy
```

Paste the clipboard contents into the `CSC_LINK` repository secret.

Store the export password as `CSC_KEY_PASSWORD`.

## Validate Notarization Credentials Locally

Before relying on CI, confirm the Apple notarization credentials work on the Mac:

```bash
xcrun notarytool history \
  --apple-id "you@example.com" \
  --password "xxxx-xxxx-xxxx-xxxx" \
  --team-id "YOUR_TEAM_ID"
```

If this fails, fix that first. The most common causes are:

- wrong app-specific password
- wrong Apple ID for the selected team
- a missing or expired Apple Developer agreement

## Windows-First Release Flow

### 1. Prepare the release on Windows

- update `package.json` version
- update the release notes doc for the new version
- commit and push to GitHub

### 2. Create and push the release tag

From Windows:

```bash
git tag v0.1.12
git push origin v0.1.12
```

That tag triggers `.github/workflows/release.yml`.

### 3. Let GitHub Actions build the release

The workflow will:

- create a draft release if one does not already exist
- build Windows artifacts
- build, sign, and notarize macOS artifacts
- upload only the public desktop downloads with human-friendly labels

If a release already exists for that tag, the workflow reuses it and replaces matching assets with `--clobber`.

### 4. Review and publish

Once the workflow finishes:

1. Open the draft release on GitHub.
2. Replace the template notes with the real release notes.
3. Verify the asset list looks right.
4. Publish the release.

## Rebuild An Existing Release

If a macOS build fails or you need to re-upload assets for an existing tag:

1. Open the `Release Desktop Builds` workflow in GitHub Actions.
2. Use `Run workflow`.
3. Enter the existing tag, for example `v0.1.12`.

The workflow will reuse the release and re-upload matching assets.

## Release Notes Template

New draft releases are created from `docs/RELEASE_DRAFT_TEMPLATE.md`.

That template intentionally starts with a `Downloads` section so users can immediately see:

- `Windows Installer`
- `Windows Portable`
- `Mac (Apple Silicon)`
- `Mac (Intel)`
- `Workflow Starter Pack` (optional, if you choose to upload it manually)

## Troubleshooting

### `Unexpected token 'E'` during notarization

That error usually means Apple returned a plain-text HTTP error and `@electron/notarize` tried to parse it as JSON.

Check the real credentials directly with:

```bash
xcrun notarytool history \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID"
```

### macOS job fails before build starts

The workflow checks for missing secrets up front. If the job says a secret is missing, verify the repository secrets are set exactly as named above.

### Release page gets noisy again

Keep public uploads limited to installers and DMGs until updater support actually exists in the app.
