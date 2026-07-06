# Troubleshooting

## A workflow opens in ComfyUI with missing nodes

That usually means the relevant custom-node package is not installed yet.

1. Copy the missing node class name from the ComfyUI error.
2. Check `../nodes/custom-node-manifest.json` for the workflow(s) that require it.
3. Install the missing package in ComfyUI Manager.
4. Re-open the workflow.

## A loader shows a missing model filename

That means the model file is not in the expected ComfyUI folder yet.

1. Check the workflow guide under `./workflows/`.
2. Use `WHERE_FILES_GO.md` to place the file in the correct ComfyUI folder.
3. Re-open the workflow after the file is in place.

## A cloud workflow still does not run

Cloud workflows still depend on:

- local ComfyUI being reachable
- the required partner/custom nodes being installed
- a valid Comfy account API key in Velorn

If the workflow is cloud-backed, you usually do not need local model weights, but you still need the correct nodes and authentication.

## Velorn says a dependency is missing

Use the workflow inside ComfyUI first, then return to Velorn and click `Re-check`. The starter pack is meant to help you close exactly that gap.

## The starter-pack JSON imports, but a node behaves differently than expected

The starter pack mirrors the workflow graphs bundled with the app. If a partner node or custom node changed upstream, update your node packages and rebuild the starter pack from the current repo before assuming the app is wrong.
