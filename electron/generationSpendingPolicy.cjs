'use strict'

// This is a spending-risk assessment, not graph validation, a sandbox, a price
// quote, or proof that a server/custom extension is honest. The native broker
// must validate the exact queued graph and fetch object_info itself from that
// exact endpoint. Never pass renderer/workflow-supplied metadata as objectInfo.
const GENERATION_SPENDING_LIMITS = Object.freeze({ nodes: 512, reportedNodes: 24, labels: 16, labelLength: 96 })

// Audited core implementations only, not naming heuristics or whole namespaces.
// Source contract: ComfyUI server.py node_info / comfy_api.latest._io emit name,
// python_module, api_node and (V3) price_badge; nodes.py stamps loaded classes
// with their actual module_parent. Thus a custom override of KSampler is NOT
// local merely because KSampler normally is. Re-audit when adding a class or
// accepting a changed module. No custom_nodes module is allowlisted.
// These are local tensor/model-file operations and simple IO/transforms used by
// the bundled YuE2, ACE-Step, LTX, WAN and SD-family graphs. The dataset exception
// is the single image resize class, not dataset/network/file-management nodes.
const localGroups = {
  nodes: `KSampler KSamplerAdvanced CheckpointLoaderSimple CLIPTextEncode CLIPSetLastLayer
    VAEDecode VAEEncode VAEEncodeForInpaint VAELoader EmptyLatentImage LatentUpscale LatentUpscaleBy
    LatentFromBatch RepeatLatentBatch SaveImage PreviewImage LoadImage LoadImageMask LoadImageOutput
    ImageScale ImageScaleBy ImageInvert ImageBatch ImagePadForOutpaint EmptyImage
    ConditioningAverage ConditioningCombine ConditioningConcat ConditioningMultiply ConditioningSetArea
    ConditioningSetAreaPercentage ConditioningSetAreaStrength ConditioningSetMask ConditioningZeroOut
    ConditioningSetTimestepRange SetLatentNoiseMask LatentComposite LatentBlend LatentRotate LatentFlip
    LatentCrop LoraLoader LoraLoaderModelOnly CLIPLoader UNETLoader DualCLIPLoader CLIPVisionEncode
    ControlNetApply ControlNetApplyAdvanced ControlNetLoader CLIPVisionLoader VAEDecodeTiled VAEEncodeTiled
    InpaintModelConditioning`,
  'comfy_extras.nodes_yue2': 'YuE2GenerateABC YuE2GenerateMusic EmptyYuE2LatentAudio',
  'comfy_extras.nodes_ace': 'TextEncodeAceStepAudio TextEncodeAceStepAudio1.5 EmptyAceStepLatentAudio EmptyAceStep1.5LatentAudio ReferenceTimbreAudio',
  // EmptyLatentAudio (audited 2026-11-09 against comfy_extras/nodes_audio.py): it only allocates a
  // zero tensor of the requested length. Used by the Sound tab's Stable Audio graph.
  'comfy_extras.nodes_audio': 'VAEEncodeAudio VAEDecodeAudio VAEDecodeAudioTiled SaveAudio SaveAudioMP3 SaveAudioOpus SaveAudioAdvanced PreviewAudio LoadAudio TrimAudioDuration EmptyLatentAudio',
  'comfy_extras.nodes_video': 'SaveVideo SaveWEBM CreateVideo GetVideoComponents LoadVideo',
  'comfy_extras.nodes_lt': 'EmptyLTXVLatentVideo LTXVImgToVideo LTXVImgToVideoInplace LTXVAddGuide LTXVCropGuides LTXVConditioning ModelSamplingLTXV LTXVScheduler LTXVPreprocess LTXVConcatAVLatent LTXVSeparateAVLatent LTXVReferenceAudio',
  'comfy_extras.nodes_lt_audio': 'LTXVAudioVAELoader LTXVAudioVAEEncode LTXVAudioVAEDecode LTXVEmptyLatentAudio LTXAVTextEncoderLoader',
  'comfy_extras.nodes_lt_upsampler': 'LTXVLatentUpsampler',
  'comfy_extras.nodes_hunyuan': 'EmptyHunyuanLatentVideo LatentUpscaleModelLoader',
  'comfy_extras.nodes_wan': 'WanImageToVideo',
  // Core H3 conditioning, latent and model-patch operations execute locally.
  // Match exact class/module pairs on every installation, not a saved workflow,
  // model filename or MiniMax brand name. API/pricing evidence still wins below.
  'comfy_extras.nodes_minimax_h3': `EmptyMiniMaxH3LatentAV MiniMaxH3ImageToVideo MiniMaxH3AddGuide
    MiniMaxH3ReferenceToVideo MiniMaxH3SigmaShift MiniMaxH3FunControlNetApply
    MiniMaxH3LatentUpscaleWithModel PH3ImageConditioning MiniMaxH3ImageConditioning`,
  'comfy_extras.nodes_custom_sampler': 'BasicScheduler KarrasScheduler ExponentialScheduler KSamplerSelect SamplerCustom BasicGuider CFGGuider RandomNoise DisableNoise SamplerCustomAdvanced ManualSigmas',
  'comfy_extras.nodes_model_advanced': 'ModelSamplingAuraFlow ModelSamplingSD3 ModelAttentionBackend',
  'comfy_extras.nodes_primitive': 'PrimitiveString PrimitiveStringMultiline PrimitiveInt PrimitiveFloat PrimitiveBoolean',
  'comfy_extras.nodes_logic': 'ComfySwitchNode ComfyNotNode ComfyAndNode ComfyOrNode',
  'comfy_extras.nodes_math': 'ComfyMathExpression',
  'comfy_extras.nodes_string': 'StringConcatenate StringReplace StringSubstring StringLength StringTrim',
  'comfy_extras.nodes_mask': 'SolidMask ImageToMask MaskToImage',
  'comfy_extras.nodes_post_processing': 'ImageScaleToTotalPixels ResizeImageMaskNode BatchImagesNode',
  'comfy_extras.nodes_images': 'GetImageSize ImageCrop RepeatImageBatch ImageFromBatch ImageScaleToMaxDimension',
  'comfy_extras.nodes_dataset': 'ResizeImagesByLongerEdge',
  'comfy_extras.nodes_preview_any': 'PreviewAny',
  'comfy_extras.nodes_cfg': 'CFGNorm',
  'comfy_extras.nodes_sd3': 'EmptySD3LatentImage',
  'comfy_extras.nodes_flux': 'EmptyFlux2LatentImage Flux2Scheduler FluxGuidance FluxKontextImageScale FluxKontextMultiReferenceLatentMethod',
  'comfy_extras.nodes_qwen': 'TextEncodeQwenImageEdit TextEncodeQwenImageEditPlus',
  // Core reference conditioning (FLUX.2 / Kontext style): attaches an encoded
  // reference picture to the prompt. Runs locally like the rest of the graph.
  'comfy_extras.nodes_edit_model': 'ReferenceLatent',
  'comfy_extras.nodes_textgen': 'TextGenerate TextGenerateLTX2Prompt',
  // Core helpers checked on 2026-11-16 for owners' own workflows: size arithmetic, and two model patches that only
  // choose how attention is computed. None of them reads a file, reaches the network or can be charged for.
  'comfy_extras.nodes_resolution': 'ResolutionSelector',
  'comfy_extras.nodes_sparse_attention': 'BlockSparseAttention',
}
// The rest of ComfyUI's own parts, so owners' workflows built from standard parts are not refused. Checked on
// 2026-11-16 against ComfyUI v0.45.0 (989d93d0): no comfy_extras module or helper it imports opens a network
// connection or starts a process, and files are only read from and written to ComfyUI's own model, input, output
// and temp folders. Same exact class/module match as above. Deliberately NOT here: training and dataset-folder
// parts, parts that write model files (CheckpointSave, ModelSave, LoraSave...), GLSLShader (runs code written in
// the workflow), the loop parts (they run more than the graph shows), WebcamCapture and RecordAudio. Core parts
// whose names look like a paid provider (Ideogram4Scheduler, TripoSplat*, MiniMaxMusic3*) still count as paid.
// Re-check this block when ComfyUI is updated: a class that moves to another module stops matching by itself.
const coreGroups = {
  'comfy_extras.nodes_advanced_samplers': `SamplerEulerCFGpp SamplerLCM SamplerLCMUpscale`,
  'comfy_extras.nodes_align_your_steps': `AlignYourStepsScheduler`,
  'comfy_extras.nodes_apg': `APG`,
  'comfy_extras.nodes_ar_video': `ARVideoI2V EmptyARVideoLatent SamplerARVideo`,
  'comfy_extras.nodes_attention_multiply': `CLIPAttentionMultiply UNetCrossAttentionMultiply UNetSelfAttentionMultiply
    UNetTemporalAttentionMultiply`,
  'comfy_extras.nodes_audio': `AudioAdjustVolume AudioConcat AudioEqualizer3Band AudioMerge ConditioningStableAudio EmptyAudio
    GetAudioLatentSize JoinAudioChannels SplitAudioChannels`,
  'comfy_extras.nodes_audio_encoder': `AudioEncoderEncode AudioEncoderLoader SheetSage2AudioToABC`,
  'comfy_extras.nodes_bernini': `BerniniConditioning`,
  'comfy_extras.nodes_bg_removal': `LoadBackgroundRemovalModel RemoveBackground`,
  'comfy_extras.nodes_boogu': `TextEncodeBooguEdit`,
  'comfy_extras.nodes_bounding_boxes': `CreateBoundingBoxes`,
  'comfy_extras.nodes_camera': `BatchCameras CreateCameraInfo CreateCameraOrbit`,
  'comfy_extras.nodes_camera_angle': `CameraAngle`,
  'comfy_extras.nodes_camera_trajectory': `WanCameraEmbedding`,
  'comfy_extras.nodes_canny': `Canny`,
  'comfy_extras.nodes_cfg': `CFGZeroStar`,
  'comfy_extras.nodes_chroma_radiance': `ChromaRadianceOptions EmptyChromaRadianceLatentImage`,
  'comfy_extras.nodes_clip_sdxl': `CLIPTextEncodeSDXL CLIPTextEncodeSDXLRefiner`,
  'comfy_extras.nodes_color': `ColorToRGBInt`,
  'comfy_extras.nodes_compositing': `JoinImageWithAlpha PorterDuffImageComposite SplitImageWithAlpha`,
  'comfy_extras.nodes_compositor': `AddLayer ImageCompositor LayersFromBoundingBoxes`,
  'comfy_extras.nodes_cond': `CLIPTextEncodeControlnet ConditioningLoader SaveConditioning T5TokenizerOptions`,
  'comfy_extras.nodes_context_windows': `ContextWindowsManual LTXVContextWindows MiniMaxH3ContextWindows WanContextWindowsManual`,
  'comfy_extras.nodes_controlnet': `ControlNetInpaintingAliMamaApply SetUnionControlNetType`,
  'comfy_extras.nodes_cosmos': `CosmosImageToVideoLatent CosmosPredict2ImageToVideoLatent EmptyCosmosLatentVideo`,
  'comfy_extras.nodes_curve': `CurveEditor ImageHistogram`,
  'comfy_extras.nodes_custom_sampler': `AddNoise BetaSamplingScheduler CFGOverride DualCFGGuider DualModelGuider ExtendIntermediateSigmas
    FlipSigmas LaplaceScheduler PolyexponentialScheduler SDTurboScheduler SamplerDPMAdaptative
    SamplerDPMPP_2M_SDE SamplerDPMPP_2S_Ancestral SamplerDPMPP_3M_SDE SamplerDPMPP_SDE SamplerER_SDE
    SamplerEulerAncestral SamplerEulerAncestralCFGPP SamplerLMS SamplerSASolver SamplerSEEDS2
    SamplingPercentToSigma SetFirstSigma SplitSigmas SplitSigmasDenoise VPScheduler`,
  'comfy_extras.nodes_dataset': `AddTextPrefix AddTextSuffix AdjustBrightness AdjustContrast CenterCropImages ImageDeduplication
    ImageGrid MergeImageLists MergeTextLists NormalizeImages RandomCropImages ReplaceText
    ResizeImagesByShorterEdge ResolutionBucket ShuffleDataset ShuffleImageTextDataset
    ShuffleVideoDataset ShuffleVideoTextDataset StripWhitespace TextToLowercase TextToUppercase
    TruncateText VideoFrameSample VideoRandomTemporalCrop VideoTemporalCrop`,
  'comfy_extras.nodes_depth_anything_3': `DA3GeometryToMesh DA3Inference DA3Render LoadDA3Model`,
  'comfy_extras.nodes_differential_diffusion': `DifferentialDiffusion`,
  'comfy_extras.nodes_easycache': `EasyCache LazyCache`,
  'comfy_extras.nodes_edit_model': `ReferenceMultiLatent`,
  'comfy_extras.nodes_eps': `TemporalScoreRescaling`,
  'comfy_extras.nodes_fibo2': `TextEncodeFibo2`,
  'comfy_extras.nodes_flux': `CLIPTextEncodeFlux Flux3LayoutPrompt FluxDisableGuidance FluxKVCache`,
  'comfy_extras.nodes_frame_interpolation': `FrameInterpolate FrameInterpolationModelLoader`,
  'comfy_extras.nodes_freelunch': `FreeU FreeU_V2`,
  'comfy_extras.nodes_fresca': `FreSca`,
  'comfy_extras.nodes_gaussian_splat': `File3DToSplat GetSplatCount MergeSplat RenderSplat SplatToFile3D SplatToMesh TransformSplat`,
  'comfy_extras.nodes_gits': `GITSScheduler`,
  'comfy_extras.nodes_hidream': `CLIPTextEncodeHiDream QuadrupleCLIPLoader`,
  'comfy_extras.nodes_hidream_o1': `EmptyHiDreamO1LatentImage HiDreamO1PatchSeamSmoothing HiDreamO1ReferenceImages`,
  'comfy_extras.nodes_hooks': `CombineHooks2 CombineHooks4 CombineHooks8 ConditioningSetDefaultCombine ConditioningSetProperties
    ConditioningSetPropertiesAndCombine ConditioningTimestepsRange CreateHookKeyframe
    CreateHookKeyframesFromFloats CreateHookKeyframesInterpolated CreateHookLora CreateHookLoraModelOnly
    CreateHookModelAsLora CreateHookModelAsLoraModelOnly PairConditioningCombine
    PairConditioningSetDefaultCombine PairConditioningSetProperties
    PairConditioningSetPropertiesAndCombine SetClipHooks SetHookKeyframes`,
  'comfy_extras.nodes_hunyuan': `CLIPTextEncodeHunyuanDiT EmptyHunyuanImageLatent EmptyHunyuanVideo15Latent HunyuanImageToVideo
    HunyuanRefinerLatent HunyuanVideo15ImageToVideo HunyuanVideo15LatentUpscaleWithModel
    HunyuanVideo15SuperResolution TextEncodeHunyuanVideo_ImageToVideo`,
  'comfy_extras.nodes_hunyuan3d': `EmptyLatentHunyuan3Dv2 Hunyuan3Dv2Conditioning Hunyuan3Dv2ConditioningMultiView VAEDecodeHunyuan3D
    VoxelToMesh VoxelToMeshBasic`,
  'comfy_extras.nodes_hypernetwork': `HypernetworkLoader`,
  'comfy_extras.nodes_hypertile': `HyperTile`,
  'comfy_extras.nodes_image_compare': `ImageCompare`,
  'comfy_extras.nodes_images': `GetLatentSize ImageAddNoise ImageColorSpace ImageCropToMask ImageCropV2 ImageFlip ImageMergeTileList
    ImageRotate ImageSDRToHDR ImageStitch PadImageNode PrimitiveBoundingBox ResizeAndPadImage
    SaveAnimatedPNG SaveAnimatedWEBP SaveImageAdvanced SaveSVGNode SplitImageToTileList`,
  'comfy_extras.nodes_ip2p': `InstructPixToPixConditioning`,
  'comfy_extras.nodes_joyimage': `TextEncodeJoyImageEdit`,
  'comfy_extras.nodes_kandinsky5': `CLIPTextEncodeKandinsky5 Kandinsky5ImageToVideo NormalizeVideoLatentStart`,
  'comfy_extras.nodes_latent': `LatentAdd LatentApplyOperation LatentApplyOperationCFG LatentBatch LatentBatchSeedBehavior
    LatentConcat LatentCut LatentCutToBatch LatentInterpolate LatentMultiply LatentOperationBlend
    LatentOperationSharpen LatentOperationTonemapReinhard LatentSubtract ReplaceVideoLatentFrames`,
  'comfy_extras.nodes_load_3d': `Load3D Load3DAdvanced Preview3D Preview3DAdvanced PreviewGaussianSplat PreviewPointCloud`,
  'comfy_extras.nodes_logic': `BranchNode CustomCombo`,
  'comfy_extras.nodes_lora_debug': `LoraLoaderBypass LoraLoaderBypassModelOnly`,
  'comfy_extras.nodes_lora_stack': `LoadLoraModel LoadLoraTextEncoder`,
  'comfy_extras.nodes_lotus': `LotusConditioning`,
  'comfy_extras.nodes_lt': `GetICLoRAParameters LTXVAddLatentGuide LTXVDualCFGGuider LTXVDurationPredictor LTXVModalityGuidance
    LTXVSpatioTemporalGuidance`,
  'comfy_extras.nodes_lt_keyframes': `LTXVAddGeneratedKeyframes LTXVFreezeLatent LTXVGeneratedKeyframesToGuides
    LTXVSeparateGeneratedKeyframes`,
  'comfy_extras.nodes_lumina2': `CLIPTextEncodeLumina2 RenormCFG`,
  'comfy_extras.nodes_mage': `TextEncodeMageFlowEdit`,
  'comfy_extras.nodes_mahiro': `Mahiro`,
  'comfy_extras.nodes_marigold': `MarigoldV2PostProcess`,
  'comfy_extras.nodes_mask': `CropMask FeatherMask GrowMask ImageColorToMask ImageCompositeMasked InvertMask LatentCompositeMasked
    MaskComposite MaskPreview ThresholdMask`,
  'comfy_extras.nodes_mediapipe': `LoadMediaPipeFaceLandmarker MediaPipeFaceLandmarker MediaPipeFaceMask MediaPipeFaceMeshVisualize`,
  'comfy_extras.nodes_mesh_io': `Get3DComponents`,
  'comfy_extras.nodes_mesh_postprocess': `ApplyTextureToMesh BakeAmbientOcclusion BakeNormalMapFromMesh BakeTextureFromViews
    BakeTextureFromVoxel DecimateMesh FillHoles MeshSmoothNormals MeshTextureToImage PaintMesh
    RemeshMesh RenderMesh RenderUVAtlas UnwrapMesh WeldVertices`,
  'comfy_extras.nodes_ming': `TextEncodeMingImageEdit`,
  'comfy_extras.nodes_mochi': `EmptyMochiLatentVideo`,
  'comfy_extras.nodes_model_advanced': `ModelComputeDtype ModelNoiseScale ModelSamplingContinuousEDM ModelSamplingContinuousV
    ModelSamplingDiscrete ModelSamplingFlux ModelSamplingStableCascade RescaleCFG VAEComputeDtype`,
  'comfy_extras.nodes_model_downscale': `PatchModelAddDownscale`,
  'comfy_extras.nodes_model_merging': `CLIPMergeAdd CLIPMergeSimple CLIPMergeSubtract ModelMergeAdd ModelMergeBlocks ModelMergeSimple
    ModelMergeSubtract`,
  'comfy_extras.nodes_model_merging_model_specific': `ModelMergeAuraflow ModelMergeCosmos14B ModelMergeCosmos7B ModelMergeCosmosPredict2_14B
    ModelMergeCosmosPredict2_2B ModelMergeFlux1 ModelMergeLTXV ModelMergeMOSSImage
    ModelMergeMochiPreview ModelMergeQwenImage ModelMergeSD1 ModelMergeSD2 ModelMergeSD35_Large
    ModelMergeSD3_2B ModelMergeSDXL ModelMergeWAN2_1`,
  'comfy_extras.nodes_model_patch': `AnimaLLLiteApply ModelPatchLoader QwenImageDiffsynthControlnet SUPIRApply USOStyleReference
    WanUni3CControlnetApply ZImageFunControlnet`,
  'comfy_extras.nodes_moge': `LoadMoGeModel MoGeGeometryToFOV MoGeInference MoGePanoramaInference MoGePointMapToMesh MoGeRender`,
  'comfy_extras.nodes_morphology': `ImageRGBToYUV ImageYUVToRGB Morphology`,
  'comfy_extras.nodes_moss_image': `MOSSImageControl MOSSImageLayoutPrompt TextEncodeMOSSImageEdit`,
  'comfy_extras.nodes_multigpu': `MultiGPU_WorkUnits SelectCLIPDevice SelectModelDevice SelectVAEDevice`,
  'comfy_extras.nodes_nag': `NAGuidance`,
  'comfy_extras.nodes_nop': `wanBlockSwap`,
  'comfy_extras.nodes_number_convert': `ComfyNumberConvert`,
  'comfy_extras.nodes_optimalsteps': `OptimalStepsScheduler`,
  'comfy_extras.nodes_pag': `PerturbedAttentionGuidance`,
  'comfy_extras.nodes_painter': `Painter`,
  'comfy_extras.nodes_perpneg': `PerpNeg PerpNegGuider`,
  'comfy_extras.nodes_photomaker': `PhotoMakerEncode PhotoMakerLoader`,
  'comfy_extras.nodes_pid': `PiDConditioning`,
  'comfy_extras.nodes_pixart': `CLIPTextEncodePixArtAlpha`,
  'comfy_extras.nodes_post_processing': `BatchLatentsNode BatchMasksNode ColorTransfer ImageBlend ImageBlur ImageQuantize ImageSharpen`,
  'comfy_extras.nodes_qwen': `EmptyQwenImageLayeredLatentImage QwenImage21Cache TextEncodeQwenImage21`,
  'comfy_extras.nodes_rebatch': `RebatchImages RebatchLatents`,
  'comfy_extras.nodes_rope': `ScaleROPE`,
  'comfy_extras.nodes_rtdetr': `DrawBBoxes RTDETR_detect`,
  'comfy_extras.nodes_sag': `SelfAttentionGuidance`,
  'comfy_extras.nodes_sam3': `SAM3_Detect SAM3_TrackPreview SAM3_TrackToMask SAM3_VideoTrack`,
  'comfy_extras.nodes_sam3d_body': `BuildPoseFile SAM3DBody_FaceExpression SAM3DBody_Loader SAM3DBody_Predict SAM3DBody_Render
    SAM3DBody_Smooth`,
  'comfy_extras.nodes_save_3d': `GetMeshInfo MergeMeshes MeshToFile3D RotateMesh Save3DAdvanced SaveGLB SaveGaussianSplat
    SavePointCloud`,
  'comfy_extras.nodes_scail': `SCAIL2ColoredMask WanSCAILToVideo`,
  'comfy_extras.nodes_sd3': `CLIPTextEncodeSD3 ControlNetApplySD3 SkipLayerGuidanceSD3 TripleCLIPLoader`,
  'comfy_extras.nodes_sdpose': `CropByBBoxes SDPoseDrawKeypoints SDPoseFaceBBoxes SDPoseKeypointExtractor`,
  'comfy_extras.nodes_sdupscale': `SD_4XUpscale_Conditioning`,
  'comfy_extras.nodes_seed': `SeedNode`,
  'comfy_extras.nodes_seedvr': `SeedVR2Conditioning SeedVR2PostProcessing SeedVR2Preprocess SeedVR2TemporalChunk
    SeedVR2TemporalMerge`,
  'comfy_extras.nodes_sensenova': `SenseNovaSamplingOptions`,
  'comfy_extras.nodes_slg': `SkipLayerGuidanceDiT SkipLayerGuidanceDiTSimple`,
  'comfy_extras.nodes_stable3d': `SV3D_Conditioning StableZero123_Conditioning StableZero123_Conditioning_Batched`,
  'comfy_extras.nodes_stable_cascade': `StableCascade_EmptyLatentImage StableCascade_StageB_Conditioning StableCascade_StageC_VAEEncode
    StableCascade_SuperResolutionControlnet`,
  'comfy_extras.nodes_string': `CaseConverter ConvertArrayToString ConvertDictionaryToString JsonExtractString RegexExtract
    RegexMatch RegexReplace StringCompare StringContains StringFormat`,
  'comfy_extras.nodes_tcfg': `TCFG`,
  'comfy_extras.nodes_text': `SaveText`,
  'comfy_extras.nodes_text_overlay': `TextOverlay`,
  'comfy_extras.nodes_textgen': `TextGenerateV2`,
  'comfy_extras.nodes_tomesd': `TomePatchModel`,
  'comfy_extras.nodes_toolkit': `CreateList GetItemFromList`,
  'comfy_extras.nodes_torch_compile': `TorchCompileModel`,
  'comfy_extras.nodes_trellis2': `EmptyTrellis2LatentStructure Pixal3DConditioning Pixal3DMultiViewConditioning Trellis2Conditioning
    Trellis2ShapeStage Trellis2TextureStage Trellis2UpsampleStage VaeDecodeShapeTrellis
    VaeDecodeStructureTrellis2 VaeDecodeTextureTrellis`,
  'comfy_extras.nodes_ultratex': `UltraTexConditioning`,
  'comfy_extras.nodes_upscale_model': `ImageUpscaleWithModel UpscaleModelLoader`,
  'comfy_extras.nodes_video': `ConcatenateVideo VideoCrop VideoTrim`,
  'comfy_extras.nodes_video_model': `ConditioningSetAreaPercentageVideo ImageOnlyCheckpointLoader SVD_img2vid_Conditioning
    VideoLinearCFGGuidance VideoTriangleCFGGuidance`,
  'comfy_extras.nodes_void': `OpticalFlowLoader VOIDInpaintConditioning VOIDQuadmaskPreprocess VOIDSampler VOIDWarpedNoise
    VOIDWarpedNoiseSource`,
  'comfy_extras.nodes_wan': `RelayVSRConditioning TrimVideoLatent VSRDecode Wan22FunControlToVideo Wan22ImageToVideoLatent
    WanAnimate2Cache WanAnimate2ToVideo WanAnimateToVideo WanCameraImageToVideo WanFirstLastFrameToVideo
    WanFunControlToVideo WanFunInpaintToVideo WanHuMoImageToVideo WanInfiniteTalkToVideo
    WanPhantomSubjectToVideo WanSoundImageToVideo WanSoundImageToVideoExtend WanTrackToVideo
    WanVaceToVideo`,
  'comfy_extras.nodes_wandancer': `WanDancerEncodeAudio WanDancerPadKeyframes WanDancerPadKeyframesList WanDancerVideo`,
  'comfy_extras.nodes_wanmove': `GenerateTracks WanMoveConcatTrack WanMoveTrackToVideo WanMoveTracksFromCoords WanMoveVisualizeTracks`,
  'comfy_extras.nodes_wevisone': `WeVisOneDetect`,
  'comfy_extras.nodes_zimage': `TextEncodeZImageOmni`,
  'nodes': `CheckpointLoader DiffControlNetLoader DiffusersLoader GLIGENLoader GLIGENTextBoxApply LoadLatent
    SaveLatent StyleModelApply StyleModelLoader unCLIPCheckpointLoader unCLIPConditioning`,
}
const split = groups => Object.entries(groups).flatMap(([module, classes]) => classes.trim().split(/\s+/).map(name => [name, module]))
// Two core class names contain a space, so they cannot sit in the space-separated lists.
const localModules = new Map([...split(localGroups), ...split(coreGroups),
  ['Epsilon Scaling', 'comfy_extras.nodes_eps'], ['Video Slice', 'comfy_extras.nodes_video']])

// Only canonical labels are returned, never arbitrary provider strings. These
// markers can only increase risk; unknown providers/classes never grant local.
const providerMarkers = [
  ['OpenAI', /openai|sora/i], ['Google', /gemini|nano.?banana|veo(?:\d|node|video|image|$)/i],
  ['ByteDance', /bytedance|seedance|seedream/i], ['xAI', /grok|(?:^|[._ -])xai(?:$|[._ -])/i],
  ['Kling', /kling/i], ['MiniMax', /minimax|hailuo/i], ['Vidu', /vidu/i],
  ['ElevenLabs', /elevenlabs/i], ['Sonilo', /sonilo/i], ['Topaz', /topaz/i],
  ['Runway', /runway/i], ['Luma', /luma(?:api|video|image|node|$)/i], ['Ideogram', /ideogram/i],
  ['Recraft', /recraft/i], ['Anthropic', /anthropic|claude/i], ['OpenRouter', /openrouter/i],
  ['fal.ai', /(?:^|[._ -])fal(?:\.ai|api|node|$)/i], ['Replicate', /replicate/i],
  ['WaveSpeed', /wavespeed/i], ['PixVerse', /pixverse/i], ['Meshy', /meshy/i],
  ['Tripo', /tripo/i], ['Krea', /krea/i], ['Black Forest Labs', /(?:^|[._ -])bfl(?:$|[._ -])|flux.?pro/i],
]
const modelKeys = ['model', 'model_name', 'model_id', 'ckpt_name', 'unet_name', 'lora_name', 'vae_name',
  'clip_name', 'clip_name1', 'clip_name2', 'clip_name3', 'audio_vae', 'text_encoder', 'upscale_model']
const privateValue = /(?:\b(?:sk-[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16})\b|\bBearer\s|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=])/i
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const own = (value, key) => plain(value) && Object.hasOwn(value, key) ? value[key] : undefined

function label(value, fallback) {
  if (typeof value !== 'string' || value.length > 160 || privateValue.test(value)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:+|() -]*$/.test(value)) return fallback
  return value.slice(0, GENERATION_SPENDING_LIMITS.labelLength)
}

function modelLabel(value) {
  // Values are names, not prompts, endpoints or private absolute paths. Keep
  // only the filename of ComfyUI-relative model paths; never show directories.
  if (typeof value !== 'string' || value.length > 512 || privateValue.test(value)
    || /^(?:[A-Za-z]:|[\\/]|~)|[:?&#=\s]/.test(value)) return null
  const parts = value.split(/[\\/]/)
  if (parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(part) || part === '..' || part === '.')) return null
  const name = parts.at(-1)
  return name.length <= GENERATION_SPENDING_LIMITS.labelLength ? name : null
}

function providersFor(value) {
  if (typeof value !== 'string' || value.length > 256) return []
  return providerMarkers.filter(([, pattern]) => pattern.test(value)).map(([name]) => name)
}

function classifyGenerationGraph(workflow, objectInfo = {}) {
  const result = { risk: 'unknown', nodeCount: 0, paidNodes: [], unknownNodes: [], providers: [], models: [], estimatedCredits: null }
  if (!plain(workflow)) return result
  const ids = Object.keys(workflow)
  result.nodeCount = ids.length
  if (!ids.length || ids.length > GENERATION_SPENDING_LIMITS.nodes) return result
  let hasPaid = false, hasUnknown = false
  const providers = new Set(), models = new Set()
  for (const id of ids) {
    const node = own(workflow, id)
    const classType = own(node, 'class_type')
    const metadata = typeof classType === 'string' ? own(objectInfo, classType) : undefined
    const module = own(metadata, 'python_module')
    const inputs = own(node, 'inputs')
    const apiNode = own(metadata, 'api_node')
    const priceBadge = own(metadata, 'price_badge')
    // MiniMax H3 has local custom-node implementations as well as a familiar
    // provider name. Its name alone is not evidence of paid cloud execution.
    // Explicit provider/API/pricing evidence below still takes precedence.
    const localH3Name = value => typeof value === 'string' && /minimax[\w. -]*h3|h3[\w. -]*minimax/i.test(value)
    const namedProviders = value => providersFor(value).filter(provider => provider !== 'MiniMax' || !localH3Name(value))
    const nodeProviders = new Set([
      ...namedProviders(classType), ...namedProviders(module),
      ...providersFor(own(metadata, 'provider')), ...providersFor(own(metadata, 'provider_name')),
      ...providersFor(own(inputs, 'provider')), ...providersFor(own(inputs, 'provider_name')),
    ])
    const apiModule = typeof module === 'string' && module.length <= 256
      && /(?:^|[._/ -])(?:api|api_nodes|cloud|remote)(?:$|[._/ -])|^comfy_api_nodes(?:\.|$)/i.test(module)
    // False/zero/empty price badges are still pricing evidence, not a verified
    // free quote. Never evaluate price_badge expressions or renderer costs.
    const paid = apiNode === true || priceBadge != null || apiModule || nodeProviders.size > 0
    const local = !paid && typeof classType === 'string' && localModules.has(classType)
      && own(metadata, 'name') === classType && module === localModules.get(classType)
      && (apiNode === undefined || apiNode === false || apiNode === null) && plain(inputs)
    const row = { id: label(id, 'unidentified'), classType: label(classType, 'Unidentified node') }
    if (paid) {
      hasPaid = true
      if (result.paidNodes.length < GENERATION_SPENDING_LIMITS.reportedNodes) result.paidNodes.push(row)
      if (!nodeProviders.size) nodeProviders.add('External API')
    } else if (!local) {
      hasUnknown = true
      if (result.unknownNodes.length < GENERATION_SPENDING_LIMITS.reportedNodes) result.unknownNodes.push(row)
    }
    for (const provider of nodeProviders) if (providers.size < GENERATION_SPENDING_LIMITS.labels) providers.add(provider)
    for (const key of modelKeys) {
      const model = modelLabel(own(inputs, key))
      if (model && models.size < GENERATION_SPENDING_LIMITS.labels) models.add(model)
    }
  }
  result.risk = hasPaid ? 'paid' : hasUnknown ? 'unknown' : 'local'
  result.providers = [...providers]
  result.models = [...models]
  return result
}

module.exports = { classifyGenerationGraph, GENERATION_SPENDING_LIMITS }
