'use strict'
const modelId = { type: 'string', enum: ['tiny', 'base', 'small', 'large-v3-turbo'], description: 'Local caption model. Defaults to base; inspect sizes and obtain approval before installation.' }
const tools = [
  { name: 'get_caption_engine_status', description: 'Read local caption engine/model availability, estimated missing downloads and session install jobs. No ComfyUI needed. Repeat this read with jobId to poll installation; it never downloads, retries or transcribes.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { modelId, jobId: { type: 'string', maxLength: 100 } } } },
  { name: 'install_caption_engine', description: 'Preview local caption speech-engine/model setup with fixed sources and estimated sizes. Show the plan and obtain approval, then apply the exact returned previewToken. A native confirmation protects downloads even under full access. Returns a background jobId immediately; poll get_caption_engine_status until completed, then transcribe_captions with the chosen modelId. No arbitrary URLs/paths, ComfyUI install, preference changes or automatic transcription.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { modelId, previewOnly: { type: 'boolean', default: true }, previewToken: { type: 'string', maxLength: 100 } } } },
]
module.exports = { tools, writableTools: ['install_caption_engine'], names: new Set(tools.map(tool => tool.name)) }
