// API-format workflow JSON for WAN 2.2 14B First-Last Frame to Video (FLF2V).
// Converted from the user's tested '▶️ Video FLF.json' (active 4-step
// lightx2v pipeline A). The action card mutates runtime inputs at submit:
//   - 97.image  = uploaded start frame filename
//   - 971.image = uploaded end frame filename
//   - 98.length = round(duration * fps) + 1
//   - 93.text   = positive prompt
//   - 89.text   = negative prompt
//   - 86.noise_seed / 85.noise_seed = same seed
//   - 94.fps    = timeline fps
//   - 108.filename_prefix = output token per job

export const WAN22_FLF2V_WORKFLOW_JSON = {
  "84": {
    "inputs": {
      "clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
      "type": "wan",
      "device": "default"
    },
    "class_type": "CLIPLoader",
    "_meta": {
      "title": ""
    }
  },
  "89": {
    "inputs": {
      "text": "A bearded man with red facial hair wearing a yellow straw hat and dark coat in Van Gogh's self-portrait style, slowly and continuously transforms into a space astronaut. The transformation flows like liquid paint - his beard fades away strand by strand, the yellow hat melts and reforms smoothly into a silver space helmet, dark coat gradually lightens and restructures into a white spacesuit. The background swirling brushstrokes slowly organize and clarify into realistic stars and space, with Earth appearing gradually in the distance. Every change happens in seamless waves, maintaining visual continuity throughout the metamorphosis.\n\nConsistent soft lighting throughout, medium close-up maintaining same framing, central composition stays fixed, gentle color temperature shift from warm to cool, gradual contrast increase, smooth style transition from painterly to photorealistic. Static camera with subtle slow zoom, emphasizing the flowing transformation process without abrupt changes.",
      "clip": [
        "84",
        0
      ]
    },
    "class_type": "CLIPTextEncode",
    "_meta": {
      "title": "CLIP Text Encode (Positive Prompt)"
    }
  },
  "93": {
    "inputs": {
      "text": "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走",
      "clip": [
        "84",
        0
      ]
    },
    "class_type": "CLIPTextEncode",
    "_meta": {
      "title": "CLIP Text Encode (Negative Prompt)"
    }
  },
  "90": {
    "inputs": {
      "vae_name": "wan_2.1_vae.safetensors"
    },
    "class_type": "VAELoader",
    "_meta": {
      "title": ""
    }
  },
  "97": {
    "inputs": {
      "image": "video_wan2_2_14B_flf2v_start_image.png"
    },
    "class_type": "LoadImage",
    "_meta": {
      "title": ""
    }
  },
  "971": {
    "inputs": {
      "image": "video_wan2_2_14B_flf2v_end_image.png"
    },
    "class_type": "LoadImage",
    "_meta": {
      "title": ""
    }
  },
  "98": {
    "inputs": {
      "width": 640,
      "height": 640,
      "length": 81,
      "batch_size": 1,
      "positive": [
        "89",
        0
      ],
      "negative": [
        "93",
        0
      ],
      "vae": [
        "90",
        0
      ],
      "start_image": [
        "97",
        0
      ],
      "end_image": [
        "971",
        0
      ]
    },
    "class_type": "WanFirstLastFrameToVideo",
    "_meta": {
      "title": ""
    }
  },
  "95": {
    "inputs": {
      "unet_name": "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
      "weight_dtype": "default"
    },
    "class_type": "UNETLoader",
    "_meta": {
      "title": ""
    }
  },
  "101": {
    "inputs": {
      "lora_name": "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
      "strength_model": 1,
      "model": [
        "95",
        0
      ]
    },
    "class_type": "LoraLoaderModelOnly",
    "_meta": {
      "title": ""
    }
  },
  "103": {
    "inputs": {
      "shift": 5,
      "model": [
        "101",
        0
      ]
    },
    "class_type": "ModelSamplingSD3",
    "_meta": {
      "title": ""
    }
  },
  "96": {
    "inputs": {
      "unet_name": "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
      "weight_dtype": "default"
    },
    "class_type": "UNETLoader",
    "_meta": {
      "title": ""
    }
  },
  "102": {
    "inputs": {
      "lora_name": "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
      "strength_model": 1,
      "model": [
        "96",
        0
      ]
    },
    "class_type": "LoraLoaderModelOnly",
    "_meta": {
      "title": ""
    }
  },
  "104": {
    "inputs": {
      "shift": 5,
      "model": [
        "102",
        0
      ]
    },
    "class_type": "ModelSamplingSD3",
    "_meta": {
      "title": ""
    }
  },
  "86": {
    "inputs": {
      "add_noise": "enable",
      "noise_seed": 984937593540091,
      "control_after_generate": "randomize",
      "steps": 4,
      "cfg": 1,
      "sampler_name": "euler",
      "scheduler": "simple",
      "start_at_step": 0,
      "end_at_step": 2,
      "return_with_leftover_noise": "enable",
      "model": [
        "103",
        0
      ],
      "positive": [
        "98",
        0
      ],
      "negative": [
        "98",
        1
      ],
      "latent_image": [
        "98",
        2
      ]
    },
    "class_type": "KSamplerAdvanced",
    "_meta": {
      "title": ""
    }
  },
  "85": {
    "inputs": {
      "add_noise": "disable",
      "noise_seed": 0,
      "control_after_generate": "fixed",
      "steps": 4,
      "cfg": 1,
      "sampler_name": "euler",
      "scheduler": "simple",
      "start_at_step": 2,
      "end_at_step": 10000,
      "return_with_leftover_noise": "disable",
      "model": [
        "104",
        0
      ],
      "positive": [
        "98",
        0
      ],
      "negative": [
        "98",
        1
      ],
      "latent_image": [
        "86",
        0
      ]
    },
    "class_type": "KSamplerAdvanced",
    "_meta": {
      "title": ""
    }
  },
  "87": {
    "inputs": {
      "samples": [
        "85",
        0
      ],
      "vae": [
        "90",
        0
      ]
    },
    "class_type": "VAEDecode",
    "_meta": {
      "title": ""
    }
  },
  "94": {
    "inputs": {
      "fps": 16,
      "images": [
        "87",
        0
      ]
    },
    "class_type": "CreateVideo",
    "_meta": {
      "title": ""
    }
  },
  "108": {
    "inputs": {
      "filename_prefix": "video/ComfyUI",
      "format": "auto",
      "codec": "auto",
      "video": [
        "94",
        0
      ]
    },
    "class_type": "SaveVideo",
    "_meta": {
      "title": ""
    }
  }
}

export const WAN22_FLF2V_NODES = {
  CLIP_LOADER: '84',
  KSAMPLER_1: '86',
  KSAMPLER_2: '85',
  VAE_DECODE: '87',
  CLIP_NEG: '89',
  VAE_LOADER: '90',
  CLIP_POS: '93',
  CREATE_VIDEO: '94',
  UNET_HIGH: '95',
  UNET_LOW: '96',
  LOAD_START: '97',
  LOAD_END: '971',
  WAN_FLF2V: '98',
  LORA_HIGH: '101',
  LORA_LOW: '102',
  MSAMP_HIGH: '103',
  MSAMP_LOW: '104',
  SAVE_VIDEO: '108',
}
