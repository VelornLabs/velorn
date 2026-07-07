import { getImportedModelRecipe } from './importedWorkflowRegistry'

const COMFY_REGISTRY_URL = 'https://registry.comfy.org'
const HUGGING_FACE_BASE_URL = 'https://huggingface.co'

function hfResolve(repo, relativePath) {
  return `${HUGGING_FACE_BASE_URL}/${repo}/resolve/main/${relativePath}`
}

function hfBlob(repo, relativePath) {
  return `${HUGGING_FACE_BASE_URL}/${repo}/blob/main/${relativePath}`
}

function modelKey(targetSubdir = '', filename = '') {
  return `${String(targetSubdir || '').trim().toLowerCase()}::${String(filename || '').trim().toLowerCase()}`
}

function createModelRecipe({
  filename,
  targetSubdir,
  displayName,
  downloadUrl,
  sourceUrl = '',
  licenseUrl = '',
  sizeBytes = null,
  sha256 = '',
  notes = '',
}) {
  return Object.freeze({
    filename,
    targetSubdir,
    displayName,
    downloadUrl,
    sourceUrl,
    licenseUrl,
    sizeBytes: Number.isFinite(sizeBytes) ? Number(sizeBytes) : null,
    sha256: String(sha256 || '').trim().toLowerCase(),
    notes: String(notes || '').trim(),
  })
}

function createAutoNodePack({
  id,
  displayName,
  repoUrl,
  installDirName,
  docsUrl = repoUrl,
  requirementsStrategy = 'requirements-txt',
  notes = '',
  classTypes = [],
}) {
  return Object.freeze({
    id,
    kind: 'auto',
    displayName,
    repoUrl,
    installDirName,
    docsUrl,
    requirementsStrategy,
    notes,
    classTypes: Object.freeze(
      (Array.isArray(classTypes) ? classTypes : [])
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
    ),
  })
}

function createCoreNodeHint({
  classType,
  docsUrl = '',
  notes = '',
  displayName = 'ComfyUI core',
  installRecommendation = 'update-comfyui',
  fallbackRepoUrl = '',
}) {
  return Object.freeze({
    classType,
    kind: 'core',
    displayName,
    docsUrl,
    notes,
    installRecommendation,
    fallbackRepoUrl,
  })
}

function createManualNodeHint({
  classType,
  displayName = 'Manual setup required',
  docsUrl = COMFY_REGISTRY_URL,
  notes = '',
  searchTerm = '',
}) {
  return Object.freeze({
    classType,
    kind: 'manual',
    displayName,
    docsUrl,
    notes,
    searchTerm: String(searchTerm || classType || '').trim(),
  })
}

export const CURATED_NODE_PACKS = Object.freeze([
  createAutoNodePack({
    id: 'kjnodes',
    displayName: 'ComfyUI-KJNodes',
    repoUrl: 'https://github.com/kijai/ComfyUI-KJNodes',
    installDirName: 'ComfyUI-KJNodes',
    docsUrl: 'https://github.com/kijai/ComfyUI-KJNodes',
    requirementsStrategy: 'requirements-txt',
    notes: 'Provides ImageResizeKJv2 and GetImagesFromBatchIndexed for bundled helper workflows.',
    classTypes: ['ImageResizeKJv2', 'GetImagesFromBatchIndexed'],
  }),
  createAutoNodePack({
    id: 'videohelpersuite',
    displayName: 'ComfyUI-VideoHelperSuite',
    repoUrl: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite',
    installDirName: 'ComfyUI-VideoHelperSuite',
    docsUrl: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite',
    requirementsStrategy: 'requirements-txt',
    notes: 'Used by some advanced/hidden video workflows such as workflow import helpers and caption tooling.',
    classTypes: ['VHS_LoadVideo', 'VHS_LoadVideoPath', 'VHS_LoadAudioUpload'],
  }),
  createAutoNodePack({
    id: 'tts-audio-suite',
    displayName: 'TTS-Audio-Suite',
    repoUrl: 'https://github.com/diodiogod/TTS-Audio-Suite',
    installDirName: 'TTS-Audio-Suite',
    docsUrl: 'https://github.com/diodiogod/TTS-Audio-Suite',
    requirementsStrategy: 'requirements-txt',
    notes: 'Provides Qwen ASR transcription, punctuation/truecase cleanup, and SRT builder nodes used by caption generation and Music Video timed lyrics.',
    classTypes: [
      'UnifiedASRTranscribeNode',
      'Qwen3TTSEngineNode',
      'ASRPunctuationTruecaseNode',
      'TextToSRTBuilderNode',
      'SRTAdvancedOptionsNode',
    ],
  }),
  createAutoNodePack({
    id: 'pysssss-custom-scripts',
    displayName: 'ComfyUI-Custom-Scripts',
    repoUrl: 'https://github.com/pythongosssss/ComfyUI-Custom-Scripts',
    installDirName: 'ComfyUI-Custom-Scripts',
    docsUrl: 'https://github.com/pythongosssss/ComfyUI-Custom-Scripts',
    requirementsStrategy: 'requirements-txt',
    notes: 'Provides Show Text, which the caption workflow uses to expose the generated SRT text back to Velorn.',
    classTypes: ['ShowText|pysssss'],
  }),
  createAutoNodePack({
    id: 'matanyone-kytra',
    displayName: 'ComfyUI_MatAnyone_Kytra',
    repoUrl: 'https://github.com/KytraScript/ComfyUI_MatAnyone_Kytra',
    installDirName: 'ComfyUI_MatAnyone_Kytra',
    docsUrl: 'https://github.com/KytraScript/ComfyUI_MatAnyone_Kytra',
    requirementsStrategy: 'requirements-txt',
    notes: 'Provides MatAnyoneVideoMatting for the bundled mask-generation workflow.',
    classTypes: ['MatAnyoneVideoMatting'],
  }),
])

const AUTO_NODE_PACK_BY_CLASS_TYPE = Object.freeze(
  CURATED_NODE_PACKS.reduce((acc, pack) => {
    for (const classType of pack.classTypes) {
      acc[classType] = pack
    }
    return acc
  }, {})
)

export const CORE_NODE_HINTS = Object.freeze({
  BatchImagesNode: createCoreNodeHint({
    classType: 'BatchImagesNode',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'This ships with modern ComfyUI builds. If it is missing, update ComfyUI first.',
  }),
  BasicGuider: createCoreNodeHint({
    classType: 'BasicGuider',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core guider node used by modern sampler graphs. Missing this usually means ComfyUI is outdated.',
  }),
  CFGGuider: createCoreNodeHint({
    classType: 'CFGGuider',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core guider node used by advanced sampler graphs. Missing this usually means ComfyUI is outdated.',
  }),
  CheckpointLoaderSimple: createCoreNodeHint({
    classType: 'CheckpointLoaderSimple',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core checkpoint loader. Missing this usually means the ComfyUI install is incomplete or very outdated.',
  }),
  CLIPLoader: createCoreNodeHint({
    classType: 'CLIPLoader',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core text-encoder loader. Missing this usually means the ComfyUI install is incomplete or very outdated.',
  }),
  CLIPTextEncode: createCoreNodeHint({
    classType: 'CLIPTextEncode',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core text encoding node. Missing this usually means the ComfyUI install is incomplete or very outdated.',
  }),
  ConditioningZeroOut: createCoreNodeHint({
    classType: 'ConditioningZeroOut',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core conditioning utility. Missing this usually means ComfyUI is outdated.',
  }),
  CreateVideo: createCoreNodeHint({
    classType: 'CreateVideo',
    docsUrl: 'https://docs.comfy.org/built-in-nodes/CreateVideo',
    notes: 'CreateVideo is part of newer ComfyUI builds.',
  }),
  EmptyFlux2LatentImage: createCoreNodeHint({
    classType: 'EmptyFlux2LatentImage',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Flux 2 latent support ships with newer ComfyUI builds.',
  }),
  EmptyHunyuanLatentVideo: createCoreNodeHint({
    classType: 'EmptyHunyuanLatentVideo',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core latent-video node used by WAN text-to-video graphs. Update ComfyUI if this is missing.',
  }),
  'EmptyAceStep1.5LatentAudio': createCoreNodeHint({
    classType: 'EmptyAceStep1.5LatentAudio',
    docsUrl: 'https://docs.comfy.org/tutorials/audio/ace-step/ace-step-v1',
    notes: 'Ace-Step nodes are bundled into newer ComfyUI builds. Update ComfyUI if this is missing.',
  }),
  EmptyLTXVLatentVideo: createCoreNodeHint({
    classType: 'EmptyLTXVLatentVideo',
    docsUrl: 'https://docs.comfy.org/built-in-nodes/EmptyLTXVLatentVideo',
    notes: 'LTX 2.3 workflow support is built into newer ComfyUI builds.',
  }),
  EmptySD3LatentImage: createCoreNodeHint({
    classType: 'EmptySD3LatentImage',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core SD3-style latent node used by Flux/LongCat graphs. Update ComfyUI if this is missing.',
  }),
  Flux2Scheduler: createCoreNodeHint({
    classType: 'Flux2Scheduler',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Flux 2 scheduler support ships with newer ComfyUI builds.',
  }),
  FluxGuidance: createCoreNodeHint({
    classType: 'FluxGuidance',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Flux guidance support ships with newer ComfyUI builds.',
  }),
  FluxKontextImageScale: createCoreNodeHint({
    classType: 'FluxKontextImageScale',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Qwen/Flux edit support ships with current ComfyUI releases.',
  }),
  ImageScaleToTotalPixels: createCoreNodeHint({
    classType: 'ImageScaleToTotalPixels',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core image sizing utility. Update ComfyUI if this is missing.',
  }),
  ImageToMask: createCoreNodeHint({
    classType: 'ImageToMask',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core mask conversion node. Missing this usually means the ComfyUI install is incomplete or very outdated.',
  }),
  KSampler: createCoreNodeHint({
    classType: 'KSampler',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core sampler node. Missing this usually means the ComfyUI install is incomplete or very outdated.',
  }),
  KSamplerAdvanced: createCoreNodeHint({
    classType: 'KSamplerAdvanced',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core advanced sampler node. Missing this usually means the ComfyUI install is incomplete or very outdated.',
  }),
  KSamplerSelect: createCoreNodeHint({
    classType: 'KSamplerSelect',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core sampler selection node used by advanced sampler graphs. Update ComfyUI if this is missing.',
  }),
  LatentUpscaleModelLoader: createCoreNodeHint({
    classType: 'LatentUpscaleModelLoader',
    docsUrl: 'https://docs.comfy.org/built-in-nodes/LatentUpscaleModelLoader',
    notes: 'This loader is built into ComfyUI. Missing it usually means the install is outdated.',
  }),
  LoadAudio: createCoreNodeHint({
    classType: 'LoadAudio',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core audio input node. Update ComfyUI if this is missing.',
  }),
  LoadImage: createCoreNodeHint({
    classType: 'LoadImage',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core image input node. Missing this usually means the ComfyUI install is incomplete or very outdated.',
  }),
  LoadVideo: createCoreNodeHint({
    classType: 'LoadVideo',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core video input node. Update ComfyUI if this is missing.',
  }),
  LoraLoaderModelOnly: createCoreNodeHint({
    classType: 'LoraLoaderModelOnly',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core LoRA loader. Missing this usually means the ComfyUI install is incomplete or very outdated.',
  }),
  MaskToImage: createCoreNodeHint({
    classType: 'MaskToImage',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core mask conversion node. Missing this usually means the ComfyUI install is incomplete or very outdated.',
  }),
  LTXAVTextEncoderLoader: createCoreNodeHint({
    classType: 'LTXAVTextEncoderLoader',
    docsUrl: 'https://docs.comfy.org/tutorials/video/ltx/ltx-2-3',
    notes: 'Update ComfyUI to a build with LTX 2.3 support. If that still does not expose the node, install or update ComfyUI-LTXVideo manually.',
    fallbackRepoUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
  }),
  LTXVAudioVAEDecode: createCoreNodeHint({
    classType: 'LTXVAudioVAEDecode',
    docsUrl: 'https://docs.comfy.org/tutorials/video/ltx/ltx-2-3',
    notes: 'Update ComfyUI to a build with LTX 2.3 support. If that still does not expose the node, install or update ComfyUI-LTXVideo manually.',
    fallbackRepoUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
  }),
  LTXVAudioVAELoader: createCoreNodeHint({
    classType: 'LTXVAudioVAELoader',
    docsUrl: 'https://docs.comfy.org/built-in-nodes/LTXVAudioVAELoader',
    notes: 'Update ComfyUI to a build with LTX 2.3 support. If that still does not expose the node, install or update ComfyUI-LTXVideo manually.',
    fallbackRepoUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
  }),
  LTXVConcatAVLatent: createCoreNodeHint({
    classType: 'LTXVConcatAVLatent',
    docsUrl: 'https://docs.comfy.org/tutorials/video/ltx/ltx-2-3',
    notes: 'LTX workflow nodes are bundled into newer ComfyUI builds.',
    fallbackRepoUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
  }),
  LTXVConditioning: createCoreNodeHint({
    classType: 'LTXVConditioning',
    docsUrl: 'https://docs.comfy.org/tutorials/video/ltx/ltx-2-3',
    notes: 'LTX workflow nodes are bundled into newer ComfyUI builds.',
    fallbackRepoUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
  }),
  LTXVCropGuides: createCoreNodeHint({
    classType: 'LTXVCropGuides',
    docsUrl: 'https://docs.comfy.org/tutorials/video/ltx/ltx-2-3',
    notes: 'LTX workflow nodes are bundled into newer ComfyUI builds.',
    fallbackRepoUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
  }),
  LTXVEmptyLatentAudio: createCoreNodeHint({
    classType: 'LTXVEmptyLatentAudio',
    docsUrl: 'https://docs.comfy.org/tutorials/video/ltx/ltx-2-3',
    notes: 'LTX workflow nodes are bundled into newer ComfyUI builds.',
    fallbackRepoUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
  }),
  LTXVImgToVideoInplace: createCoreNodeHint({
    classType: 'LTXVImgToVideoInplace',
    docsUrl: 'https://docs.comfy.org/tutorials/video/ltx/ltx-2-3',
    notes: 'LTX workflow nodes are bundled into newer ComfyUI builds.',
    fallbackRepoUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
  }),
  LTXVLatentUpsampler: createCoreNodeHint({
    classType: 'LTXVLatentUpsampler',
    docsUrl: 'https://docs.comfy.org/tutorials/video/ltx/ltx-2-3',
    notes: 'LTX workflow nodes are bundled into newer ComfyUI builds.',
    fallbackRepoUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
  }),
  LTXVPreprocess: createCoreNodeHint({
    classType: 'LTXVPreprocess',
    docsUrl: 'https://docs.comfy.org/tutorials/video/ltx/ltx-2-3',
    notes: 'LTX workflow nodes are bundled into newer ComfyUI builds.',
    fallbackRepoUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
  }),
  LTXVSeparateAVLatent: createCoreNodeHint({
    classType: 'LTXVSeparateAVLatent',
    docsUrl: 'https://docs.comfy.org/tutorials/video/ltx/ltx-2-3',
    notes: 'LTX workflow nodes are bundled into newer ComfyUI builds.',
    fallbackRepoUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
  }),
  ModelSamplingAuraFlow: createCoreNodeHint({
    classType: 'ModelSamplingAuraFlow',
    docsUrl: 'https://docs.comfy.org/built-in-nodes/ModelSamplingAuraFlow',
    notes: 'This sampler ships with newer ComfyUI builds.',
  }),
  ManualSigmas: createCoreNodeHint({
    classType: 'ManualSigmas',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core sigma schedule node used by advanced sampler graphs. Update ComfyUI if this is missing.',
  }),
  ModelSamplingSD3: createCoreNodeHint({
    classType: 'ModelSamplingSD3',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core SD3-style model sampling node used by WAN text-to-video. Update ComfyUI if this is missing.',
  }),
  RandomNoise: createCoreNodeHint({
    classType: 'RandomNoise',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core sampler noise node. Missing this usually means ComfyUI is outdated.',
  }),
  ResizeImageMaskNode: createCoreNodeHint({
    classType: 'ResizeImageMaskNode',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Part of current ComfyUI core image utilities.',
  }),
  ResizeImagesByLongerEdge: createCoreNodeHint({
    classType: 'ResizeImagesByLongerEdge',
    docsUrl: 'https://docs.comfy.org/built-in-nodes/ResizeImagesByLongerEdge',
    notes: 'Part of current ComfyUI core image utilities.',
  }),
  SaveAudioMP3: createCoreNodeHint({
    classType: 'SaveAudioMP3',
    docsUrl: 'https://docs.comfy.org/tutorials/audio/ace-step/ace-step-v1',
    notes: 'Ace-Step audio save nodes are included in newer ComfyUI builds.',
  }),
  SaveImage: createCoreNodeHint({
    classType: 'SaveImage',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core image output node. Missing this usually means the ComfyUI install is incomplete or very outdated.',
  }),
  SaveVideo: createCoreNodeHint({
    classType: 'SaveVideo',
    docsUrl: 'https://docs.comfy.org/built-in-nodes/CreateVideo',
    notes: 'Core video output support ships with newer ComfyUI builds.',
  }),
  SamplerCustomAdvanced: createCoreNodeHint({
    classType: 'SamplerCustomAdvanced',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core advanced sampler node. Missing this usually means ComfyUI is outdated.',
  }),
  SetLatentNoiseMask: createCoreNodeHint({
    classType: 'SetLatentNoiseMask',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core latent-mask utility. Missing this usually means ComfyUI is outdated.',
  }),
  'TextEncodeAceStepAudio1.5': createCoreNodeHint({
    classType: 'TextEncodeAceStepAudio1.5',
    docsUrl: 'https://docs.comfy.org/tutorials/audio/ace-step/ace-step-v1',
    notes: 'Update ComfyUI to a build with Ace-Step 1.5 support if this node is missing.',
  }),
  TextEncodeQwenImageEdit: createCoreNodeHint({
    classType: 'TextEncodeQwenImageEdit',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Native Qwen/LongCat image edit support ships with newer ComfyUI builds.',
  }),
  TextEncodeQwenImageEditPlus: createCoreNodeHint({
    classType: 'TextEncodeQwenImageEditPlus',
    docsUrl: 'https://docs.comfy.org/built-in-nodes/TextEncodeQwenImageEditPlus',
    notes: 'Native Qwen image edit support ships with newer ComfyUI builds.',
  }),
  UNETLoader: createCoreNodeHint({
    classType: 'UNETLoader',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core diffusion model loader. Missing this usually means the ComfyUI install is incomplete or very outdated.',
  }),
  VAEDecodeAudio: createCoreNodeHint({
    classType: 'VAEDecodeAudio',
    docsUrl: 'https://docs.comfy.org/tutorials/audio/ace-step/ace-step-v1',
    notes: 'Ace-Step audio decode support ships with newer ComfyUI builds.',
  }),
  VAEDecodeTiled: createCoreNodeHint({
    classType: 'VAEDecodeTiled',
    docsUrl: 'https://docs.comfy.org/built-in-nodes/VAEDecodeTiled',
    notes: 'Tiled VAE decode is part of current ComfyUI core.',
  }),
  VAELoader: createCoreNodeHint({
    classType: 'VAELoader',
    docsUrl: `${COMFY_REGISTRY_URL}`,
    notes: 'Core VAE loader. Missing this usually means the ComfyUI install is incomplete or very outdated.',
  }),
  WanImageToVideo: createCoreNodeHint({
    classType: 'WanImageToVideo',
    docsUrl: 'https://docs.comfy.org/tutorials/video/wan/wan2_2',
    notes: 'Update ComfyUI first. If WanImageToVideo is still missing afterwards, install a maintained Wan wrapper such as ComfyUI-WanVideoWrapper manually.',
    fallbackRepoUrl: 'https://github.com/kijai/ComfyUI-WanVideoWrapper',
  }),
})

export const MANUAL_NODE_HINTS = Object.freeze({
  ByteDanceSeedreamNode: createManualNodeHint({
    classType: 'ByteDanceSeedreamNode',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
  ByteDance2FirstLastFrameNode: createManualNodeHint({
    classType: 'ByteDance2FirstLastFrameNode',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This Seedance 2.0 cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
  ByteDance2ReferenceNode: createManualNodeHint({
    classType: 'ByteDance2ReferenceNode',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This Seedance 2.0 cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
  ByteDance2TextToVideoNode: createManualNodeHint({
    classType: 'ByteDance2TextToVideoNode',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This Seedance 2.0 cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
  CFGNorm: createManualNodeHint({
    classType: 'CFGNorm',
    displayName: 'LongCat helper node',
    notes: 'Install the LongCat/Flux helper nodes through the Comfy Registry or ComfyUI Manager if this is missing.',
    searchTerm: 'CFGNorm LongCat ComfyUI',
  }),
  ComfyMathExpression: createManualNodeHint({
    classType: 'ComfyMathExpression',
    displayName: 'ComfyUI helper node',
    notes: 'Install the helper/custom-node pack that provides ComfyMathExpression through the Comfy Registry or ComfyUI Manager.',
    searchTerm: 'ComfyMathExpression',
  }),
  ComfySwitchNode: createManualNodeHint({
    classType: 'ComfySwitchNode',
    displayName: 'ComfyUI helper node',
    notes: 'Install the helper/custom-node pack that provides ComfySwitchNode through the Comfy Registry or ComfyUI Manager.',
    searchTerm: 'ComfySwitchNode',
  }),
  FluxKontextMultiReferenceLatentMethod: createManualNodeHint({
    classType: 'FluxKontextMultiReferenceLatentMethod',
    displayName: 'Flux/LongCat helper node',
    notes: 'Install the Flux Kontext/LongCat helper nodes through the Comfy Registry or ComfyUI Manager if this is missing.',
    searchTerm: 'FluxKontextMultiReferenceLatentMethod',
  }),
  FrameInterpolate: createManualNodeHint({
    classType: 'FrameInterpolate',
    displayName: 'Frame interpolation nodes',
    docsUrl: 'https://github.com/Fannovel16/ComfyUI-Frame-Interpolation',
    notes: 'Install ComfyUI-Frame-Interpolation or an equivalent frame interpolation node pack.',
    searchTerm: 'ComfyUI-Frame-Interpolation',
  }),
  FrameInterpolationModelLoader: createManualNodeHint({
    classType: 'FrameInterpolationModelLoader',
    displayName: 'Frame interpolation nodes',
    docsUrl: 'https://github.com/Fannovel16/ComfyUI-Frame-Interpolation',
    notes: 'Install ComfyUI-Frame-Interpolation or an equivalent frame interpolation node pack.',
    searchTerm: 'ComfyUI-Frame-Interpolation',
  }),
  GeminiNanoBanana2: createManualNodeHint({
    classType: 'GeminiNanoBanana2',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
  GeminiNode: createManualNodeHint({
    classType: 'GeminiNode',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
  GetVideoComponents: createManualNodeHint({
    classType: 'GetVideoComponents',
    displayName: 'Video helper node',
    notes: 'Install the video helper/custom-node pack that provides GetVideoComponents through the Comfy Registry or ComfyUI Manager.',
    searchTerm: 'GetVideoComponents',
  }),
  GrokImageNode: createManualNodeHint({
    classType: 'GrokImageNode',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
  GrokVideoNode: createManualNodeHint({
    classType: 'GrokVideoNode',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
  KlingOmniProImageToVideoNode: createManualNodeHint({
    classType: 'KlingOmniProImageToVideoNode',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
  OpenAIGPTImage1: createManualNodeHint({
    classType: 'OpenAIGPTImage1',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This OpenAI cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
  LoadSAM3Model: createManualNodeHint({
    classType: 'LoadSAM3Model',
    displayName: 'ComfyUI-SAM3',
    docsUrl: 'https://github.com/PozzettiAndrea/ComfyUI-SAM3',
    notes: 'Install via ComfyUI Manager or clone ComfyUI-SAM3 and run `python install.py`. This pack uses a comfy-env installer instead of a plain requirements.txt flow.',
    searchTerm: 'ComfyUI-SAM3',
  }),
  SAM3Propagate: createManualNodeHint({
    classType: 'SAM3Propagate',
    displayName: 'ComfyUI-SAM3',
    docsUrl: 'https://github.com/PozzettiAndrea/ComfyUI-SAM3',
    notes: 'Install via ComfyUI Manager or clone ComfyUI-SAM3 and run `python install.py`. This pack uses a comfy-env installer instead of a plain requirements.txt flow.',
    searchTerm: 'ComfyUI-SAM3',
  }),
  SAM3VideoOutput: createManualNodeHint({
    classType: 'SAM3VideoOutput',
    displayName: 'ComfyUI-SAM3',
    docsUrl: 'https://github.com/PozzettiAndrea/ComfyUI-SAM3',
    notes: 'Install via ComfyUI Manager or clone ComfyUI-SAM3 and run `python install.py`. This pack uses a comfy-env installer instead of a plain requirements.txt flow.',
    searchTerm: 'ComfyUI-SAM3',
  }),
  SAM3VideoSegmentation: createManualNodeHint({
    classType: 'SAM3VideoSegmentation',
    displayName: 'ComfyUI-SAM3',
    docsUrl: 'https://github.com/PozzettiAndrea/ComfyUI-SAM3',
    notes: 'Install via ComfyUI Manager or clone ComfyUI-SAM3 and run `python install.py`. This pack uses a comfy-env installer instead of a plain requirements.txt flow.',
    searchTerm: 'ComfyUI-SAM3',
  }),
  PreviewAny: createManualNodeHint({
    classType: 'PreviewAny',
    displayName: 'Preview helper node',
    notes: 'Install the preview/helper custom-node pack that provides PreviewAny through the Comfy Registry or ComfyUI Manager.',
    searchTerm: 'PreviewAny',
  }),
  ResolutionSelector: createManualNodeHint({
    classType: 'ResolutionSelector',
    displayName: 'Resolution helper node',
    notes: 'Install the helper/custom-node pack that provides ResolutionSelector through the Comfy Registry or ComfyUI Manager.',
    searchTerm: 'ResolutionSelector',
  }),
  StringReplace: createManualNodeHint({
    classType: 'StringReplace',
    displayName: 'Text helper node',
    notes: 'Install the text/helper custom-node pack that provides StringReplace through the Comfy Registry or ComfyUI Manager.',
    searchTerm: 'StringReplace',
  }),
  SoniloVideoToMusic: createManualNodeHint({
    classType: 'SoniloVideoToMusic',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This Sonilo cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
  TextGenerate: createManualNodeHint({
    classType: 'TextGenerate',
    displayName: 'Text generation helper node',
    notes: 'Install the text-generation helper nodes used by the Ernie prompt enhancer through the Comfy Registry or ComfyUI Manager.',
    searchTerm: 'TextGenerate ComfyUI',
  }),
  TopazVideoEnhance: createManualNodeHint({
    classType: 'TopazVideoEnhance',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
  Vidu2ImageToVideoNode: createManualNodeHint({
    classType: 'Vidu2ImageToVideoNode',
    displayName: 'Partner node via Comfy Registry',
    notes: 'This cloud partner node is not mapped to a stable unattended install recipe yet. Use the registry or ComfyUI Manager.',
  }),
})

export const MODEL_INSTALL_RECIPES = Object.freeze({
  [modelKey('vae', 'ace_1.5_vae.safetensors')]: createModelRecipe({
    filename: 'ace_1.5_vae.safetensors',
    targetSubdir: 'vae',
    displayName: 'ACE-Step 1.5 VAE',
    downloadUrl: hfResolve('Comfy-Org/ace_step_1.5_ComfyUI_files', 'split_files/vae/ace_1.5_vae.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/ace_step_1.5_ComfyUI_files', 'split_files/vae/ace_1.5_vae.safetensors'),
    licenseUrl: 'https://huggingface.co/ACE-Step/Ace-Step1.5',
    sizeBytes: 337431732,
    notes: 'Required by the built-in music generation workflow.',
  }),
  [modelKey('text_encoders', 'qwen_0.6b_ace15.safetensors')]: createModelRecipe({
    filename: 'qwen_0.6b_ace15.safetensors',
    targetSubdir: 'text_encoders',
    displayName: 'ACE-Step 1.5 Qwen 0.6B text encoder',
    downloadUrl: hfResolve('Comfy-Org/ace_step_1.5_ComfyUI_files', 'split_files/text_encoders/qwen_0.6b_ace15.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/ace_step_1.5_ComfyUI_files', 'split_files/text_encoders/qwen_0.6b_ace15.safetensors'),
    licenseUrl: 'https://huggingface.co/ACE-Step/Ace-Step1.5',
    // Size/checksum not curated yet — the download still works; it just skips
    // hash verification and shows "Unknown size" until confirmed on HF.
    notes: 'Text encoder for the built-in ACE-Step 1.5 music workflow (DualCLIPLoader).',
  }),
  [modelKey('text_encoders', 'qwen_1.7b_ace15.safetensors')]: createModelRecipe({
    filename: 'qwen_1.7b_ace15.safetensors',
    targetSubdir: 'text_encoders',
    displayName: 'ACE-Step 1.5 Qwen 1.7B text encoder',
    downloadUrl: hfResolve('Comfy-Org/ace_step_1.5_ComfyUI_files', 'split_files/text_encoders/qwen_1.7b_ace15.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/ace_step_1.5_ComfyUI_files', 'split_files/text_encoders/qwen_1.7b_ace15.safetensors'),
    licenseUrl: 'https://huggingface.co/ACE-Step/Ace-Step1.5',
    notes: 'Text encoder for the built-in ACE-Step 1.5 music workflow (DualCLIPLoader).',
  }),
  [modelKey('diffusion_models', 'acestep_v1.5_turbo.safetensors')]: createModelRecipe({
    filename: 'acestep_v1.5_turbo.safetensors',
    targetSubdir: 'diffusion_models',
    displayName: 'ACE-Step 1.5 Turbo diffusion model',
    downloadUrl: hfResolve('Comfy-Org/ace_step_1.5_ComfyUI_files', 'split_files/diffusion_models/acestep_v1.5_turbo.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/ace_step_1.5_ComfyUI_files', 'split_files/diffusion_models/acestep_v1.5_turbo.safetensors'),
    licenseUrl: 'https://huggingface.co/ACE-Step/Ace-Step1.5',
    sizeBytes: 4790000000,
    notes: 'Required by the built-in music generation workflow.',
  }),
  [modelKey('vae', 'ae.safetensors')]: createModelRecipe({
    filename: 'ae.safetensors',
    targetSubdir: 'vae',
    displayName: 'Z Image Turbo VAE',
    downloadUrl: hfResolve('Comfy-Org/z_image_turbo', 'split_files/vae/ae.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/z_image_turbo', 'split_files/vae/ae.safetensors'),
    licenseUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo',
    sizeBytes: 335304388,
    sha256: 'afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38',
    notes: 'Flux-compatible VAE used by Z Image Turbo.',
  }),
  [modelKey('text_encoders', 'gemma_3_12B_it_fp4_mixed.safetensors')]: createModelRecipe({
    filename: 'gemma_3_12B_it_fp4_mixed.safetensors',
    targetSubdir: 'text_encoders',
    displayName: 'Gemma 3 12B FP4 mixed text encoder',
    downloadUrl: hfResolve('Comfy-Org/ltx-2', 'split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/ltx-2', 'split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors'),
    licenseUrl: 'https://huggingface.co/google/gemma-3-12b-it-qat-q4_0-unquantized',
    sizeBytes: 9447702218,
    notes: 'Used by the LTX 2.3 workflow text encoder loader.',
  }),
  [modelKey('checkpoints', 'ltx-2.3-22b-dev-fp8.safetensors')]: createModelRecipe({
    filename: 'ltx-2.3-22b-dev-fp8.safetensors',
    targetSubdir: 'checkpoints',
    displayName: 'LTX 2.3 22B FP8 checkpoint',
    downloadUrl: hfResolve('Lightricks/LTX-2.3-fp8', 'ltx-2.3-22b-dev-fp8.safetensors'),
    sourceUrl: hfBlob('Lightricks/LTX-2.3-fp8', 'ltx-2.3-22b-dev-fp8.safetensors'),
    licenseUrl: 'https://huggingface.co/Lightricks/LTX-2.3-fp8',
    sizeBytes: 29145431166,
    notes: 'Main checkpoint used by the bundled LTX 2.3 workflow.',
  }),
  [modelKey('loras', 'ltx-2.3-22b-distilled-lora-384.safetensors')]: createModelRecipe({
    filename: 'ltx-2.3-22b-distilled-lora-384.safetensors',
    targetSubdir: 'loras',
    displayName: 'LTX 2.3 distilled LoRA',
    downloadUrl: hfResolve('Lightricks/LTX-2.3', 'ltx-2.3-22b-distilled-lora-384-1.1.safetensors'),
    sourceUrl: hfBlob('Lightricks/LTX-2.3', 'ltx-2.3-22b-distilled-lora-384-1.1.safetensors'),
    licenseUrl: 'https://huggingface.co/Lightricks/LTX-2.3',
    sizeBytes: 7605507256,
    notes: 'Downloaded from the official Lightricks repo and saved under the workflow-expected filename.',
  }),
  [modelKey('latent_upscale_models', 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors')]: createModelRecipe({
    filename: 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors',
    targetSubdir: 'latent_upscale_models',
    displayName: 'LTX 2.3 spatial upscaler x2',
    downloadUrl: hfResolve('Lightricks/LTX-2.3', 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors'),
    sourceUrl: hfBlob('Lightricks/LTX-2.3', 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors'),
    licenseUrl: 'https://huggingface.co/Lightricks/LTX-2.3',
    sizeBytes: 995743560,
    notes: 'Required for the bundled LTX 2.3 upscaling step.',
  }),
  [modelKey('text_encoders', 'qwen_2.5_vl_7b_fp8_scaled.safetensors')]: createModelRecipe({
    filename: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
    targetSubdir: 'text_encoders',
    displayName: 'Qwen 2.5 VL 7B FP8 text encoder',
    downloadUrl: hfResolve('Comfy-Org/Qwen-Image_ComfyUI', 'split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Qwen-Image_ComfyUI', 'split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors'),
    licenseUrl: 'https://huggingface.co/Qwen/Qwen-Image',
    sizeBytes: 9380000000,
    notes: 'Shared by Qwen image edit and multiple-angle workflows.',
  }),
  [modelKey('text_encoders', 'qwen_3_4b.safetensors')]: createModelRecipe({
    filename: 'qwen_3_4b.safetensors',
    targetSubdir: 'text_encoders',
    displayName: 'Qwen 3 4B text encoder',
    downloadUrl: hfResolve('Comfy-Org/z_image_turbo', 'split_files/text_encoders/qwen_3_4b.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/z_image_turbo', 'split_files/text_encoders/qwen_3_4b.safetensors'),
    licenseUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo',
    sizeBytes: 8040000000,
    notes: 'Text encoder used by Z Image Turbo.',
  }),
  [modelKey('diffusion_models', 'qwen_image_edit_2509_fp8_e4m3fn.safetensors')]: createModelRecipe({
    filename: 'qwen_image_edit_2509_fp8_e4m3fn.safetensors',
    targetSubdir: 'diffusion_models',
    displayName: 'Qwen Image Edit 2509 FP8 diffusion model',
    downloadUrl: hfResolve('Comfy-Org/Qwen-Image-Edit_ComfyUI', 'split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Qwen-Image-Edit_ComfyUI', 'split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors'),
    licenseUrl: 'https://huggingface.co/Qwen/Qwen-Image-Edit-2509',
    sizeBytes: 20400000000,
    notes: 'Shared by Qwen image edit and multiple-angle workflows.',
  }),
  [modelKey('vae', 'qwen_image_vae.safetensors')]: createModelRecipe({
    filename: 'qwen_image_vae.safetensors',
    targetSubdir: 'vae',
    displayName: 'Qwen image VAE',
    downloadUrl: hfResolve('Comfy-Org/Qwen-Image_ComfyUI', 'split_files/vae/qwen_image_vae.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Qwen-Image_ComfyUI', 'split_files/vae/qwen_image_vae.safetensors'),
    licenseUrl: 'https://huggingface.co/Qwen/Qwen-Image',
    sizeBytes: 253806246,
    notes: 'Shared by Qwen image edit and multiple-angle workflows.',
  }),
  [modelKey('loras', 'Qwen-Edit-2509-Multiple-angles.safetensors')]: createModelRecipe({
    filename: 'Qwen-Edit-2509-Multiple-angles.safetensors',
    targetSubdir: 'loras',
    displayName: 'Qwen multiple-angles LoRA',
    downloadUrl: hfResolve('Comfy-Org/Qwen-Image-Edit_ComfyUI', 'split_files/loras/Qwen-Edit-2509-Multiple-angles.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Qwen-Image-Edit_ComfyUI', 'split_files/loras/Qwen-Edit-2509-Multiple-angles.safetensors'),
    licenseUrl: 'https://huggingface.co/dx8152/Qwen-Edit-2509-Multiple-angles',
    sizeBytes: 236117032,
    notes: 'Enables the bundled multi-angle helper workflows.',
  }),
  [modelKey('loras', 'Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors')]: createModelRecipe({
    filename: 'Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors',
    targetSubdir: 'loras',
    displayName: 'Qwen Image Edit lightning 4-step LoRA',
    downloadUrl: hfResolve('lightx2v/Qwen-Image-Lightning', 'Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors'),
    sourceUrl: hfBlob('lightx2v/Qwen-Image-Lightning', 'Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors'),
    licenseUrl: 'https://huggingface.co/lightx2v/Qwen-Image-Lightning',
    sizeBytes: 849608296,
    notes: 'Optional speed LoRA used by the bundled Qwen image edit workflow.',
  }),
  [modelKey('text_encoders', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors')]: createModelRecipe({
    filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    targetSubdir: 'text_encoders',
    displayName: 'WAN UMT5 XXL FP8 text encoder',
    downloadUrl: hfResolve('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors'),
    licenseUrl: 'https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B',
    sizeBytes: 6735906897,
    notes: 'Text encoder for the bundled WAN 2.2 workflow.',
  }),
  [modelKey('diffusion_models', 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors')]: createModelRecipe({
    filename: 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors',
    targetSubdir: 'diffusion_models',
    displayName: 'WAN 2.2 high-noise expert diffusion model',
    downloadUrl: hfResolve('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors'),
    licenseUrl: 'https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B',
    sizeBytes: 14294742832,
    notes: 'One of the two MoE expert models required for WAN 2.2 image-to-video.',
  }),
  [modelKey('loras', 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors')]: createModelRecipe({
    filename: 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors',
    targetSubdir: 'loras',
    displayName: 'WAN 2.2 4-step high-noise LoRA',
    downloadUrl: hfResolve('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors'),
    licenseUrl: 'https://huggingface.co/lightx2v/Wan2.2-Lightning',
    sizeBytes: 1230000000,
    sha256: 'd176c808d6fc461999b68e321efcb7501b20b8c3797523ed0df14f7d1deff11e',
    notes: 'ComfyUI-repackaged filename that matches the bundled WAN workflow.',
  }),
  [modelKey('loras', 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors')]: createModelRecipe({
    filename: 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors',
    targetSubdir: 'loras',
    displayName: 'WAN 2.2 4-step low-noise LoRA',
    downloadUrl: hfResolve('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors'),
    licenseUrl: 'https://huggingface.co/lightx2v/Wan2.2-Lightning',
    sizeBytes: 1230000000,
    sha256: '024f21de095bc8fad9809ded3e9e49a2e170dcf27075da8145ba7d60d8aab7f9',
    notes: 'ComfyUI-repackaged filename that matches the bundled WAN workflow.',
  }),
  [modelKey('diffusion_models', 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors')]: createModelRecipe({
    filename: 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors',
    targetSubdir: 'diffusion_models',
    displayName: 'WAN 2.2 low-noise expert diffusion model',
    downloadUrl: hfResolve('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors'),
    licenseUrl: 'https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B',
    sizeBytes: 14294742832,
    notes: 'One of the two MoE expert models required for WAN 2.2 image-to-video.',
  }),
  [modelKey('vae', 'wan_2.1_vae.safetensors')]: createModelRecipe({
    filename: 'wan_2.1_vae.safetensors',
    targetSubdir: 'vae',
    displayName: 'WAN 2.1 VAE',
    downloadUrl: hfResolve('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/vae/wan_2.1_vae.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/vae/wan_2.1_vae.safetensors'),
    licenseUrl: 'https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B',
    sizeBytes: 253815318,
    notes: 'Shared VAE for the bundled WAN 2.2 workflow.',
  }),
  [modelKey('diffusion_models', 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors')]: createModelRecipe({
    filename: 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors',
    targetSubdir: 'diffusion_models',
    displayName: 'WAN 2.2 T2V high-noise expert diffusion model',
    downloadUrl: hfResolve('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors'),
    licenseUrl: 'https://huggingface.co/Wan-AI/Wan2.2-T2V-A14B',
    sizeBytes: 14293923632,
    notes: 'One of the two MoE expert models required for WAN 2.2 text-to-video.',
  }),
  [modelKey('diffusion_models', 'wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors')]: createModelRecipe({
    filename: 'wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors',
    targetSubdir: 'diffusion_models',
    displayName: 'WAN 2.2 T2V low-noise expert diffusion model',
    downloadUrl: hfResolve('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors'),
    licenseUrl: 'https://huggingface.co/Wan-AI/Wan2.2-T2V-A14B',
    sizeBytes: 14293923632,
    notes: 'One of the two MoE expert models required for WAN 2.2 text-to-video.',
  }),
  [modelKey('loras', 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors')]: createModelRecipe({
    filename: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors',
    targetSubdir: 'loras',
    displayName: 'WAN 2.2 T2V 4-step high-noise LoRA',
    downloadUrl: hfResolve('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors'),
    licenseUrl: 'https://huggingface.co/lightx2v/Wan2.2-Lightning',
    sizeBytes: 1226977424,
    notes: 'Speed LoRA used by the bundled WAN 2.2 text-to-video workflow.',
  }),
  [modelKey('loras', 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors')]: createModelRecipe({
    filename: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors',
    targetSubdir: 'loras',
    displayName: 'WAN 2.2 T2V 4-step low-noise LoRA',
    downloadUrl: hfResolve('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors'),
    licenseUrl: 'https://huggingface.co/lightx2v/Wan2.2-Lightning',
    sizeBytes: 1226977424,
    notes: 'Speed LoRA used by the bundled WAN 2.2 text-to-video workflow.',
  }),
  [modelKey('diffusion_models', 'longcat_image_bf16.safetensors')]: createModelRecipe({
    filename: 'longcat_image_bf16.safetensors',
    targetSubdir: 'diffusion_models',
    displayName: 'LongCat Image BF16 diffusion model',
    downloadUrl: hfResolve('Comfy-Org/LongCat-Image', 'split_files/diffusion_models/longcat_image_bf16.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/LongCat-Image', 'split_files/diffusion_models/longcat_image_bf16.safetensors'),
    licenseUrl: 'https://huggingface.co/Comfy-Org/LongCat-Image',
    sizeBytes: 12541383144,
    sha256: '7c83c314a3d879d43e5700072033256000f46a56900ae48b209a77ac1921488b',
    notes: 'Primary local text-to-image model used by the bundled LongCat workflow.',
  }),
  [modelKey('diffusion_models', 'ernie-image-turbo.safetensors')]: createModelRecipe({
    filename: 'ernie-image-turbo.safetensors',
    targetSubdir: 'diffusion_models',
    displayName: 'ERNIE Image Turbo diffusion model',
    downloadUrl: hfResolve('Comfy-Org/ERNIE-Image', 'diffusion_models/ernie-image-turbo.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/ERNIE-Image', 'diffusion_models/ernie-image-turbo.safetensors'),
    licenseUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image',
    sizeBytes: 16067025480,
    notes: 'Primary local model used by the bundled Ernie Image Turbo workflow.',
  }),
  [modelKey('text_encoders', 'ministral-3-3b.safetensors')]: createModelRecipe({
    filename: 'ministral-3-3b.safetensors',
    targetSubdir: 'text_encoders',
    displayName: 'Ministral 3 3B ERNIE text encoder',
    downloadUrl: hfResolve('Comfy-Org/ERNIE-Image', 'text_encoders/ministral-3-3b.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/ERNIE-Image', 'text_encoders/ministral-3-3b.safetensors'),
    licenseUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image',
    sizeBytes: 7717637511,
    notes: 'Text encoder used by the bundled Ernie Image Turbo workflow.',
  }),
  [modelKey('text_encoders', 'ernie-image-prompt-enhancer.safetensors')]: createModelRecipe({
    filename: 'ernie-image-prompt-enhancer.safetensors',
    targetSubdir: 'text_encoders',
    displayName: 'ERNIE prompt enhancer text encoder',
    downloadUrl: hfResolve('Comfy-Org/ERNIE-Image', 'text_encoders/ernie-image-prompt-enhancer.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/ERNIE-Image', 'text_encoders/ernie-image-prompt-enhancer.safetensors'),
    licenseUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image',
    sizeBytes: 6877439999,
    notes: 'Prompt enhancement encoder used by the bundled Ernie Image Turbo workflow.',
  }),
  [modelKey('vae', 'flux2-vae.safetensors')]: createModelRecipe({
    filename: 'flux2-vae.safetensors',
    targetSubdir: 'vae',
    displayName: 'Flux 2 VAE',
    downloadUrl: hfResolve('Comfy-Org/ERNIE-Image', 'vae/flux2-vae.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/ERNIE-Image', 'vae/flux2-vae.safetensors'),
    licenseUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image',
    sizeBytes: 336213556,
    notes: 'Flux 2 VAE used by the bundled Ernie Image Turbo workflow.',
  }),
  [modelKey('diffusion_models', 'flux2_dev_fp8mixed.safetensors')]: createModelRecipe({
    filename: 'flux2_dev_fp8mixed.safetensors',
    targetSubdir: 'diffusion_models',
    displayName: 'Flux 2 Dev FP8 mixed diffusion model',
    downloadUrl: hfResolve('Comfy-Org/flux2-dev', 'split_files/diffusion_models/flux2_dev_fp8mixed.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/flux2-dev', 'split_files/diffusion_models/flux2_dev_fp8mixed.safetensors'),
    licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-dev',
    sizeBytes: 35455599592,
    notes: 'Primary local model used by the bundled Flux 2 text-to-image workflow.',
  }),
  [modelKey('text_encoders', 'mistral_3_small_flux2_bf16.safetensors')]: createModelRecipe({
    filename: 'mistral_3_small_flux2_bf16.safetensors',
    targetSubdir: 'text_encoders',
    displayName: 'Mistral 3 Small Flux 2 BF16 text encoder',
    downloadUrl: hfResolve('Comfy-Org/flux2-dev', 'split_files/text_encoders/mistral_3_small_flux2_bf16.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/flux2-dev', 'split_files/text_encoders/mistral_3_small_flux2_bf16.safetensors'),
    licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-dev',
    sizeBytes: 35584897447,
    notes: 'Text encoder used by the bundled Flux 2 text-to-image workflow.',
  }),
  [modelKey('vae', 'full_encoder_small_decoder.safetensors')]: createModelRecipe({
    filename: 'full_encoder_small_decoder.safetensors',
    targetSubdir: 'vae',
    displayName: 'Flux 2 full encoder small decoder VAE',
    downloadUrl: hfResolve('black-forest-labs/FLUX.2-small-decoder', 'full_encoder_small_decoder.safetensors'),
    sourceUrl: hfBlob('black-forest-labs/FLUX.2-small-decoder', 'full_encoder_small_decoder.safetensors'),
    licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-small-decoder',
    sizeBytes: 249519092,
    sha256: 'ea4273f02d1fafbf8e1d1c2cf6018ed8748652eb0bf34f2dd91171f16f15ab62',
    notes: 'VAE used by the bundled Flux 2 text-to-image workflow.',
  }),
  [modelKey('loras', 'Flux_2-Turbo-LoRA_comfyui.safetensors')]: createModelRecipe({
    filename: 'Flux_2-Turbo-LoRA_comfyui.safetensors',
    targetSubdir: 'loras',
    displayName: 'Flux 2 Turbo LoRA',
    downloadUrl: hfResolve('Comfy-Org/flux2-dev', 'split_files/loras/Flux_2-Turbo-LoRA_comfyui.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/flux2-dev', 'split_files/loras/Flux_2-Turbo-LoRA_comfyui.safetensors'),
    licenseUrl: 'https://huggingface.co/fal/FLUX.2-dev-Turbo',
    sizeBytes: 2760814880,
    sha256: '011487390b8020baf22a9d543930c90d74a4809b7241bee6b0622777b17b413b',
    notes: 'Speed LoRA used by the bundled Flux 2 text-to-image workflow.',
  }),
  [modelKey('frame_interpolation', 'film_net_fp16.safetensors')]: createModelRecipe({
    filename: 'film_net_fp16.safetensors',
    targetSubdir: 'frame_interpolation',
    displayName: 'FILM frame interpolation model',
    downloadUrl: hfResolve('Comfy-Org/frame_interpolation', 'frame_interpolation/film_net_fp16.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/frame_interpolation', 'frame_interpolation/film_net_fp16.safetensors'),
    licenseUrl: 'https://huggingface.co/Comfy-Org/frame_interpolation',
    sizeBytes: 68882302,
    notes: 'FILM model used by the bundled frame interpolation workflow.',
  }),
  [modelKey('diffusion_models', 'z_image_turbo_bf16.safetensors')]: createModelRecipe({
    filename: 'z_image_turbo_bf16.safetensors',
    targetSubdir: 'diffusion_models',
    displayName: 'Z Image Turbo BF16 diffusion model',
    downloadUrl: hfResolve('Comfy-Org/z_image_turbo', 'split_files/diffusion_models/z_image_turbo_bf16.safetensors'),
    sourceUrl: hfBlob('Comfy-Org/z_image_turbo', 'split_files/diffusion_models/z_image_turbo_bf16.safetensors'),
    licenseUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo',
    sizeBytes: 12309866400,
    notes: 'Primary local text-to-image model used by the bundled Z Image Turbo workflow.',
  }),
})

export function getNodeInstallInfo(classType = '') {
  const normalized = String(classType || '').trim()
  if (!normalized) {
    return Object.freeze({
      classType: '',
      kind: 'unknown',
      displayName: 'Unknown dependency',
      docsUrl: COMFY_REGISTRY_URL,
      notes: 'No class type was provided for this node dependency.',
    })
  }

  const autoPack = AUTO_NODE_PACK_BY_CLASS_TYPE[normalized]
  if (autoPack) {
    return Object.freeze({
      classType: normalized,
      ...autoPack,
    })
  }

  if (CORE_NODE_HINTS[normalized]) {
    return CORE_NODE_HINTS[normalized]
  }

  if (MANUAL_NODE_HINTS[normalized]) {
    return MANUAL_NODE_HINTS[normalized]
  }

  return Object.freeze({
    classType: normalized,
    kind: 'manual',
    displayName: 'Manual setup required',
    docsUrl: COMFY_REGISTRY_URL,
    searchTerm: normalized,
    notes: 'No curated install recipe is available yet for this node class.',
  })
}

export function getModelInstallInfo({ filename = '', targetSubdir = '' } = {}) {
  const key = modelKey(targetSubdir, filename)
  const recipe = MODEL_INSTALL_RECIPES[key]
  if (recipe) return recipe

  const importedRecipe = getImportedModelRecipe({ filename, targetSubdir })
  if (importedRecipe) return importedRecipe

  return Object.freeze({
    filename: String(filename || '').trim(),
    targetSubdir: String(targetSubdir || '').trim(),
    displayName: String(filename || '').trim() || 'Unknown model',
    downloadUrl: '',
    sourceUrl: '',
    licenseUrl: '',
    sizeBytes: null,
    sha256: '',
    notes: 'No curated download recipe is available yet for this model.',
  })
}

export function isNodeAutoInstallable(classType = '') {
  return getNodeInstallInfo(classType).kind === 'auto'
}

export function isModelAutoInstallable(model = {}) {
  return Boolean(getModelInstallInfo(model).downloadUrl)
}
