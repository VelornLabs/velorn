# AI Release Handoff

Read this before helping with ComfyStudio commits, tags, or desktop releases.

## Important

Do **not** tell the user to build or sign the Mac app manually unless GitHub Actions is broken and the user explicitly asks for a manual fallback.

The normal release flow is:

1. Commit the release changes.
2. Push `main`.
3. Push a version tag, for example `v0.1.12`.
4. GitHub Actions builds Windows, macOS, and Linux.
5. GitHub Actions signs and notarizes macOS.
6. GitHub creates or updates a draft release with assets.

The workflow is:

```text
.github/workflows/release.yml
```

The release process doc is:

```text
docs/RELEASE_PROCESS.md
```

The secrets/setup doc is:

```text
docs/CI_SECRETS.md
```

## What Gets Built

The GitHub Actions release workflow uploads:

- `Windows Installer`
- `Windows Portable`
- `Mac (Apple Silicon)`
- `Mac (Intel)`
- `Linux AppImage`
- `Linux deb`

Do not upload `.blockmap` or `latest*.yml` files unless auto-update support is added later.

## Release Checklist

1. Check git status.
2. Do not commit generated release folders or local media files unless the user explicitly asks.
3. Confirm `package.json` has the new release version.
4. Confirm `package-lock.json` matches the same version.
5. Run `npm run build`.
6. Commit the release changes.
7. Push `main`.
8. Create and push the version tag:

```bash
git tag -a v0.1.12 -m "ComfyStudio v0.1.12"
git push origin refs/tags/v0.1.12
```

9. Ask the user to check `Actions > Release Desktop Builds`.
10. When the jobs are green, ask the user to review and publish the draft release.

## If GitHub Actions Fails

Open the failed job and inspect the last failing step.

Common cases:

- Windows upload fails: check artifact filenames in `package.json` and `.github/workflows/release.yml`.
- macOS signing fails: check GitHub secrets from `docs/CI_SECRETS.md`.
- macOS notarization fails: verify Apple credentials and agreements.

## Safety Rules

- Never commit `.p12` files.
- Never commit Apple passwords.
- Never commit app-specific passwords.
- Never commit API keys.
- Never commit GitHub tokens.
- Keep secrets in GitHub repository secrets only.

## Manual Mac Builds

Manual Mac builds are now a fallback, not the default.

Only use the Mac manually if:

- GitHub Actions is broken, and
- the user explicitly asks for a manual Mac build.
