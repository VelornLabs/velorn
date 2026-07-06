# Music Generation

Generate music from tags and lyrics

- **Workflow ID:** `music-gen`
- **Category:** `audio`
- **Tier:** `lite`
- **Runtime:** `local`
- **App Workflow JSON:** `/workflows/music_generation.json`
- **Starter Pack Setup Workflow:** `workflows/local/music-gen.comfyui.json`
- **Setup Workflow Status:** `available`

## What This Setup Workflow Is
- A ComfyUI-importable copy of the workflow graph bundled with Velorn.
- Use it to inspect missing nodes, model loaders, and expected filenames directly inside ComfyUI.
- This is a local workflow: expect to install the listed custom nodes and local model files before it runs successfully.

## Required Custom Nodes
- `SaveAudioMP3` - Built into newer ComfyUI builds
  - Ace-Step audio save nodes are included in newer ComfyUI builds.
  - Docs: https://docs.comfy.org/tutorials/audio/ace-step/ace-step-v1
- `TextEncodeAceStepAudio1.5` - Built into newer ComfyUI builds
  - Update ComfyUI to a build with Ace-Step 1.5 support if this node is missing.
  - Docs: https://docs.comfy.org/tutorials/audio/ace-step/ace-step-v1
- `VAEDecodeAudio` - Built into newer ComfyUI builds
  - Ace-Step audio decode support ships with newer ComfyUI builds.
  - Docs: https://docs.comfy.org/tutorials/audio/ace-step/ace-step-v1

## Required Models
| Filename | ComfyUI Folder | Loader | Input Key | Download |
|---|---|---|---|---|
| `ace_1.5_vae.safetensors` | `models/vae` | `VAELoader` | `vae_name` | [Download](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/vae/ace_1.5_vae.safetensors) |
| `acestep_v1.5_turbo.safetensors` | `models/diffusion_models` | `UNETLoader` | `unet_name` | [Download](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/diffusion_models/acestep_v1.5_turbo.safetensors) |

## API Key
- Not required for this workflow.

## Setup Steps
1. Import `workflows/local/music-gen.comfyui.json` into ComfyUI.
2. Let ComfyUI show any missing custom nodes, then install them in ComfyUI Manager.
3. Place the required model files into the folders listed above.
4. Re-open the workflow in ComfyUI and confirm all loaders resolve.
5. Return to Velorn Generate and click `Re-check` before queueing.

## Related Guides
- `../WHERE_FILES_GO.md`
- `../API_KEYS.md`
- `../TROUBLESHOOTING.md`

