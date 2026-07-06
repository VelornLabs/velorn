# Where Files Go

Use this guide when a starter-pack workflow tells you a model file is missing.

## ComfyUI folders

The starter pack lists target folders using ComfyUI's standard `models/` structure:

- `models/checkpoints` for classic checkpoint models when applicable
- `models/diffusion_models` for UNets and diffusion backbones
- `models/vae` for VAE files
- `models/text_encoders` for CLIP, T5, Qwen, and related text encoders
- `models/loras` for LoRA files

If a workflow guide lists `models/diffusion_models`, place that exact filename in ComfyUI's `models/diffusion_models/` folder.

## Custom nodes

Custom nodes are separate from model weights.

- Install them with ComfyUI Manager when possible.
- If a workflow opens in ComfyUI and shows a missing node class, use that name to locate the correct node package.
- The aggregated node list lives in `../nodes/custom-node-manifest.json`.

## Starter-pack workflow JSONs

The importable workflow files in this pack are split by runtime:

- `../workflows/local/*.comfyui.json`
- `../workflows/cloud/*.comfyui.json`

These are intended for manual inspection and setup inside ComfyUI.

## App outputs

When you run a workflow in plain ComfyUI, outputs go to your normal ComfyUI output folders.

When you run the workflow through Velorn, generated assets are routed back into the project structure used by the app.

## Good workflow-prep loop

1. Import the starter-pack workflow JSON into ComfyUI.
2. Let ComfyUI reveal missing nodes or model files.
3. Install the missing nodes and place the missing models in the folders above.
4. Re-open the workflow in ComfyUI to confirm everything resolves.
5. Return to Velorn and use `Re-check` before queueing.
