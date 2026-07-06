# API Keys

Some starter-pack workflows are `cloud` workflows. They still run through your local ComfyUI instance, but they authenticate partner-node requests with a Comfy account API key.

## When you need a key

You need a Comfy account API key for workflows marked as:

- `cloud` runtime
- `requiresComfyOrgApiKey: true` in `../starter-pack.manifest.json`

Typical examples include partner-node image and video workflows such as Nano Banana, Kling, Grok, Vidu, and Seedream.

## Where to enter it in Velorn

Open:

`Settings > ComfyUI Connection > Comfy Account API Key`

Velorn sends this key as `extra_data.api_key_comfy_org` when queueing compatible workflows.

## What the starter pack does not do

- It does not store your real API key.
- It does not include credentials in any workflow JSON.
- It does not replace the need for local ComfyUI.

## Troubleshooting

- If a cloud workflow loads in ComfyUI but fails from Velorn, confirm the API key is saved in the app.
- If the node itself is missing, install the required partner/custom node package first.
- If authentication fails, confirm the key is valid and has access to the partner workflow you are trying to run.
