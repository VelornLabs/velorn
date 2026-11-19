## Downloads

- `Windows Installer`: standard Windows install experience for most users
- `Windows Portable`: no-install Windows build for quick testing or portable use
- `Mac (Apple Silicon)`: for M1, M2, M3, and newer Macs
- `Mac (Intel)`: for older Intel-based Macs
- `Linux AppImage`: portable Linux build
- `Linux deb`: Debian/Ubuntu package
- `Workflow Starter Pack` (optional): advanced ComfyUI setup aid for users who want to inspect workflows manually

Ignore the auto-generated source-code archives unless you plan to build Velorn from source.

## Highlights

- **A finished result is always saved.** In 0.4.0 a finished video from Visuals could end with "It finished, but couldn't be saved". Velorn now downloads a result from whatever address Comfy gives, as ComfyUI does, and no longer refuses a file for its size or format.
- If this happened to you: Comfy keeps a result for 24 hours. Install 0.4.1, open the same project and go to Visuals. Velorn picks the job up and saves it, without a new charge.

Full notes: [docs/RELEASE_NOTES_0.4.1.md](https://github.com/VelornLabs/velorn/blob/main/docs/RELEASE_NOTES_0.4.1.md). Everything new in 0.4.0: [docs/RELEASE_NOTES_0.4.0.md](https://github.com/VelornLabs/velorn/blob/main/docs/RELEASE_NOTES_0.4.0.md)

## Notes

- Visuals and Sound spend credits from your own Comfy account. The price is shown first.
- Local models and custom workflows still use a separate local ComfyUI installation.
- GPU sharing is experimental and off until you switch it on.
