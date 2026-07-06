# Release Notes Template

Use this when publishing a GitHub Release so normal app users and advanced ComfyUI users know which download they actually need.

## Choose The Right Download

- **Desktop app:** for most users who just want to install Velorn and use it.
- **Workflow Starter Pack (optional):** for advanced ComfyUI users who want to inspect workflows directly in ComfyUI and prepare nodes/models manually.

## Desktop App

- Windows installer
- Windows portable build
- macOS Apple Silicon DMG
- macOS Intel DMG

The desktop app includes Velorn and its built-in workflow definitions. It does **not** include ComfyUI itself.

## Workflow Starter Pack (Optional)

The starter pack includes:

- workflow dependency docs
- machine-readable node/model manifests
- ComfyUI-importable workflow JSONs for manual inspection and setup
- where-files-go, API key, and troubleshooting docs

Download this only if you want to prepare your ComfyUI environment manually outside the app.

Advanced ComfyUI users can usually treat it like this:

1. Download the Workflow Starter Pack
2. Open the workflows in ComfyUI
3. Install any missing custom nodes
4. Download any missing models
5. Return to Velorn and use `Generate`

## Important Setup Note

Velorn generation still depends on a separate local ComfyUI installation.

- Local workflows may require custom nodes and local model files.
- Cloud workflows still use local ComfyUI and may require partner nodes plus a Comfy account API key.

## Getting Started

After launching the app:

1. Choose a projects folder.
2. Create or open a project.
3. Open `Velorn > Getting Started` from the bottom menu.

## Known Limitations

- This is a pre-release.
- ComfyUI connections are local-only in this build.
- Some workflows still require manual node/model setup.
- Cloud pricing can be dynamic for certain workflows.
