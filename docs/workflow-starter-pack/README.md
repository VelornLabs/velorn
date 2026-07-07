# Workflow Starter Pack

This folder defines the optional `Workflow Starter Pack` for advanced ComfyUI users.

Most Velorn users should download the desktop app and rely on the in-app dependency checks. The starter pack exists for people who prefer to inspect workflows directly in ComfyUI, install missing nodes/models manually, and validate their environment outside the app.

## What this pack includes

- `README.md` - overview and maintenance notes for the starter pack itself.
- `INDEX.md` - human-readable workflow index with links to setup JSONs and per-workflow guides.
- `starter-pack.manifest.json` - machine-readable summary of workflow dependencies.
- `release.json` - version/build metadata for the packaged starter pack.
- `RELEASE_NOTES.md` - summary of what the current starter-pack build includes.
- `docs/workflows/*.md` - per-workflow setup checklists.
- `workflows/local/*.comfyui.json` - local workflow graphs prepared for manual ComfyUI import.
- `workflows/cloud/*.comfyui.json` - cloud/partner workflow graphs prepared for manual ComfyUI import.
- `nodes/custom-node-manifest.json` - aggregated custom-node requirements.
- `models/model-manifest.json` - aggregated model requirements and target folders.
- `checksums/SHA256SUMS.txt` - hashes for the shipped starter-pack files.

## Build commands

```bash
npm run starter-pack:build
npm run starter-pack:package
```

`starter-pack:build` refreshes the docs, manifests, checksums, and importable workflow JSON copies under this folder.

`starter-pack:package` rebuilds the pack and writes a versioned zip to `release/`.

## Maintenance rules

When adding or changing workflows:

1. Update `src/config/workflowRegistry.js`.
2. Update `src/config/workflowDependencyPacks.js`.
3. Run `npm run starter-pack:build`.
4. Verify the generated `docs/workflows/*.md`, `workflows/local/*.comfyui.json`, and `workflows/cloud/*.comfyui.json` files are still correct.
5. Run `npm run starter-pack:package` before uploading the zip to GitHub Releases.

## Publishing recommendation

- Publish a versioned zip such as `velorn-workflow-starter-pack-vX.Y.Z.zip`.
- Upload it beside the desktop app binaries on GitHub Releases.
- In release notes, describe it as optional and intended for advanced ComfyUI users only.
