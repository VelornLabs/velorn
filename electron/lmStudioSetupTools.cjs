'use strict'

const id = { type: 'string', minLength: 1, maxLength: 128, description: 'Exact native plan/job ID from the preceding LM Studio setup result.' }
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const definitions = [
  ['plan_lmstudio_model_setup', 'plan', true, schema({
    repository: { type: 'string', minLength: 3, maxLength: 160, description: 'Exact public Hugging Face owner/repository for the selected single-file GGUF. Not a URL or search query.' },
    filename: { type: 'string', minLength: 6, maxLength: 180, description: 'Exact single-file GGUF filename/quantization from the selected repository. No directory path, shards or MLX bundles.' },
  }), 'Inspect a selected LM Studio model download without downloading weights: exact repository/file, pinned revision/checksum, bytes, license and destination. Checks existing installation/storage. Review these details with the user first. Does not change the active agent, load models, start inference or configure ComfyUI.'],
  ['download_lmstudio_model', 'download', false, schema({ planId: id }), 'Download the exact model from a fresh LM Studio plan, with mandatory native desktop approval even under Full access. Returns a background job immediately. Velorn shows live progress and Cancel in the originating desktop chat after the reply. No automatic load, provider switch, paid generation or duplicate retry.'],
  ['get_lmstudio_model_download', 'status', true, schema({ jobId: id }), 'Read cached native LM Studio download/load status. Downloaded is not loaded or connected. Ready means the local model and connection were verified, not that inference/tool use was tested.'],
  ['cancel_lmstudio_model_download', 'cancel', false, schema({ jobId: id }), 'Cancel only this native-owned model download. Does not delete an existing model, uninstall LM Studio, cancel another client\'s transfer, unload a model or switch agents. Completed files remain.'],
  ['load_lmstudio_model', 'load', false, schema({ jobId: id }), 'After a completed verified download, request separately approved LM Studio model loading and local connection verification. May start its loopback-only server on port 1234. Does not change authentication/network sharing, unload other models, select LM Studio as the agent or run a prompt. Returns background loading status; use the live card or status tool.'],
]
const tools = Object.freeze(definitions.map(([name, , readOnlyHint, inputSchema, description]) => ({ name, description, inputSchema,
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint,
    openWorldHint: ['plan_lmstudio_model_setup', 'download_lmstudio_model'].includes(name) },
})))
const methods = Object.freeze(Object.fromEntries(definitions.map(([name, method]) => [name, method])))
const names = new Set(definitions.map(([name]) => name))
const readNames = new Set(definitions.filter(([, , read]) => read).map(([name]) => name))
const guidance = 'For an LM Studio MODEL download, use plan_lmstudio_model_setup with the exact public Hugging Face repository and single-file GGUF filename after choosing a suitable model with the user. Model name alone is not an exact quantization/file. Present the returned pinned source, license, size, destination and remaining steps; do not invent these details. Use download_lmstudio_model with the returned planId. Native desktop confirmation is mandatory even under Full access. Approved downloads have live desktop chat progress and Cancel after the agent reply; do not hold the agent turn open to poll or start duplicate transfers. Downloaded does not mean loaded. After completion, use load_lmstudio_model only when requested, or let the user click Load and check connection in the card; this has its own native approval and background status. Keep the current Codex agent/model/chat until the user explicitly switches. Never use ComfyUI download_agent_model for LM Studio, bypass a failed/unsupported plan with shell downloads, disable authentication, expose a server beyond loopback, or claim model/tool compatibility without a separate user-authorized test. First release supports reviewed single-file GGUF, not MLX/sharded/gated models. Missing LM Studio still uses plan_tool_setup for its application installer. Editing and agent setup remain optional.'

module.exports = { tools, methods, names, readNames, guidance }
