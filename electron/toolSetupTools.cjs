'use strict'

// A separate catalog keeps installer actions out of passive optionalSetup reads.
const schema = (key, property) => ({ type: 'object', properties: { [key]: property }, required: [key], additionalProperties: false })
const id = { type: 'string', minLength: 1, maxLength: 100, description: 'Exact opaque ID returned by the preceding setup tool; never invent one.' }
const definitions = [
  ['plan_tool_setup', 'plan', true, schema('integration', { type: 'string', enum: ['lmstudio', 'comfyui'] }),
    'Preview optional LM Studio or ComfyUI setup for this computer: platform, existing app/service, official installer source, size, download destination and user steps. Read-only bounded checks, including official HTTPS metadata; no installer/model download, login, settings change or inference. Managed installer downloads currently support Apple Silicon macOS only; other platforms get the official guide.'],
  ['download_tool_installer', 'download', false, schema('planId', id),
    'Request download of the exact installer in a fresh plan_tool_setup result. Always requires a separate native desktop confirmation, including with Full access. No arbitrary source/path, automatic installation, model download or generation. After approval, returns a job ID immediately while transfer continues asynchronously; an initial zero-byte count is not completion or a stalled download. Connected-agent requests get live desktop chat progress, Cancel and a separately approved Open installer action. Inspect status before retrying; do not keep the agent turn running just to poll. A declined or expired plan is not permission to bypass with shell commands.'],
  ['get_tool_setup_download', 'status', true, schema('jobId', id),
    'Read cached progress of this window/session\'s optional installer download. Completed means only a downloaded file, not installed, connected or model-ready. No network request or filesystem mutation.'],
  ['cancel_tool_setup_download', 'cancel', false, schema('jobId', id),
    'Cancel the specified optional installer download. Removes only its incomplete download if still owned. Does not uninstall an application or change a project; completed installers remain available.'],
  ['open_tool_installer', 'open', false, schema('jobId', id),
    'Request opening a completed, verified-unchanged downloaded DMG through macOS. Always asks for native desktop confirmation. The user finishes vendor installation, OS prompts, local instance/server setup and separately approved model downloads. Does not install automatically or certify readiness. Recheck get_setup_status after the user finishes.'],
]
const tools = Object.freeze(definitions.map(([name, , readOnlyHint, inputSchema, description]) => ({ name, description, inputSchema,
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: name === 'plan_tool_setup' || name === 'download_tool_installer' },
})))
const methods = Object.freeze(Object.fromEntries(definitions.map(([name, method]) => [name, method])))
const names = new Set(definitions.map(([name]) => name))
const readNames = new Set(definitions.filter(([, , read]) => read).map(([name]) => name))
const guidance = 'Agents and ComfyUI are optional; ordinary editing needs neither. For requests to install or set up LM Studio or ComfyUI, start with plan_tool_setup for that integration and present the returned source, size, destination, compatibility caveats and remaining user steps. Use the bounded download_tool_installer and open_tool_installer actions only for that approved plan; both require native desktop confirmation even under Full access. A successful download response is the approved background-transfer receipt, not completion: initial zero bytes is normal. For connected-agent requests, Velorn shows live progress in the desktop chat after the turn ends, with Cancel and separately confirmed Open installer. Explain this handoff; do not ask for the same download approval again, start a duplicate download, or hold the agent turn open with repeated polling. Cached get_tool_setup_download remains available on request. Do not bypass a refusal, unavailable download, or OS protection with shell installers, sudo or quarantine changes. Opening an installer is not installation success. The user completes vendor/OS prompts; Comfy Desktop needs a local Standalone instance, and LM Studio needs a separately selected/downloaded/loaded model and loopback server. Model downloads require their own size, storage and license review; never silently choose a large model. Do not choose Cloud, enable paid generation, change firewall/network exposure, or switch the current agent/model as a setup shortcut. After the user finishes, use get_setup_status to verify; use existing guide_comfyui_setup preview/apply with an explicit port to connect ComfyUI. Not responding does not establish uninstalled. No setup action provides Velo access.'

module.exports = { tools, methods, names, readNames, guidance }
