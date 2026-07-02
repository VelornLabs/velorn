import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Clipboard, ExternalLink, Film, Loader2, RefreshCw, X } from 'lucide-react'
import {
  CUSTOM_AD_KEYFRAME_WORKFLOW_ID,
  GPT_IMAGE_2_UGC_KEYFRAME_WORKFLOW_ID,
  SEEDANCE_UGC_VIDEO_WORKFLOW_ID,
} from '../../config/generateWorkspaceConfig'

// One-shot flow: brief -> references -> one Seedance generation of the whole ad.
// (The legacy per-shot steps — Script Review / Voiceover / Keyframes / Videos —
// are no longer in the nav; their render blocks remain but are unreachable.)
const STEPS = [
  { id: 'setup', label: 'The Vibe' },
  { id: 'references', label: 'References' },
  { id: 'generate', label: 'Generate' },
]

// Ready-made ElevenLabs voices (must match the alias list in
// normalizeElevenLabsVoiceName in services/comfyui.js). One pinned voice drives
// every spoken shot so the creator sounds identical across the whole ad.
const VOICE_OPTIONS = [
  'Jessica (female, american)',
  'Laura (female, american)',
  'Sarah (female, american)',
  'River (non-binary, american)',
  'Roger (male, american)',
  'Callum (male, american)',
  'Eric (male, american)',
  'Liam (male, american)',
  'George (male, british)',
  'Charlie (male, australian)',
]

// ElevenLabs TTS models. v3 is the most expressive and supports inline emotion
// tags like [excited]/[skeptical]; v2 is the stable fallback (tags ignored).
const VOICE_MODEL_OPTIONS = [
  { id: 'eleven_v3', label: 'v3 — most expressive', helper: 'Best emotion + per-line delivery tags. Needs v3 access on your ElevenLabs plan.' },
  { id: 'eleven_multilingual_v2', label: 'v2 — stable', helper: 'Reliable everywhere, flatter. Delivery tags are ignored; use the slider.' },
]

const FIXED_UGC_FPS = 25 // LTX 2.3's native rate (forced for the one-shot lip-sync path).
const MIN_UGC_LENGTH_SECONDS = 3
const MAX_UGC_LENGTH_SECONDS = 15 // Seedance / LTX one-shot generation caps at ~15s.
const RECOMMENDED_UGC_LENGTH_MIN = 6
const RECOMMENDED_UGC_LENGTH_MAX = 15

const UGC_FORMAT_OPTIONS = [
  { id: 'casual_review', label: 'Casual Review', emoji: '🤳', helper: '"Okay I need to show you this" - talking to camera like a friend.' },
  { id: 'unboxing_asmr', label: 'Unboxing ASMR', emoji: '📦', helper: 'Hands-only reveal. Taps, peels, and satisfying first looks.' },
  { id: 'demo_review', label: 'Demo Review', emoji: '🧪', helper: '"Does it actually work?" Test it on camera, react for real.' },
  { id: 'try_on_grwm', label: 'Try-On / GRWM', emoji: '🪞', helper: 'Get-ready-with-me energy. Wear it, style it, judge it.' },
  { id: 'mini_testimonial', label: 'Mini Testimonial', emoji: '💯', helper: '"I use this every day" - believable, calm, zero ad voice.' },
  { id: 'reaction_hook', label: 'Reaction Hook', emoji: '😱', helper: '"WAIT. Look at this." Curiosity does the heavy lifting.' },
  { id: 'problem_solution', label: 'Problem / Solution', emoji: '🛠️', helper: 'Quick pain point -> product saves the day -> honest verdict.' },
]

// Per-format structure skeletons. Injected into the external-LLM prompt so each
// template steers the LLM toward its own camera grammar + beats + vibe, instead
// of every format producing the same generic script.
const UGC_ARCHETYPE_SPECS = {
  casual_review: [
    'Structure — Casual Review: selfie talking-to-camera review, iPhone front/back camera mix.',
    'Beats: hook (raise the product to the lens) -> show a key detail on the back camera -> a quick real use/demo -> honest reaction -> soft recommendation.',
    'Talking creator, natural short dialogue, handheld friend-showing-a-friend energy.',
  ].join('\n'),
  unboxing_asmr: [
    'Structure — Unboxing ASMR: overhead top-down, hands-only, NO face.',
    'Beats: tap + open the packaging -> peel/reveal the product -> lift and rotate to show it -> arrange a final beauty-shot display.',
    'Slow deliberate movements, crisp amplified sounds (tap, peel, rustle), little or no dialogue, cozy tactile vibe.',
  ].join('\n'),
  demo_review: [
    'Structure — Demo Review: "does it actually work?" real test.',
    'Beats: set up the claim or a bit of skepticism -> use the product for real in the environment -> show the result clearly -> honest verdict.',
    'Talking creator, often mid-activity with real effort; believable, not polished.',
  ].join('\n'),
  try_on_grwm: [
    'Structure — Try-On / GRWM: fast multi-cut style edit with varied angles (POV tease, detail, low-angle, full-body, walking).',
    'Beats: tease the item -> detail shots -> wear/style it -> confident poses -> walk-away.',
    'Mostly visual with minimal dialogue, music-driven, editorial-but-casual; works in 9:16 or 3:4.',
  ].join('\n'),
  mini_testimonial: [
    'Structure — Mini Testimonial: calm, believable everyday-use endorsement.',
    'Beats: relatable intro -> how they actually use it day to day -> why it matters to them -> quiet soft endorsement.',
    'Talking creator, low-key and grounded, zero hype or ad-voice.',
  ].join('\n'),
  reaction_hook: [
    'Structure — Reaction Hook: curiosity-driven, strong "wait, look at this" open.',
    'Beats: instant curiosity hook -> reveal the thing -> genuine reaction -> quick payoff / why it matters.',
    'Talking creator, surprised and intrigued energy, fast and punchy.',
  ].join('\n'),
  problem_solution: [
    'Structure — Problem / Solution: pain point, then the product fixes it.',
    'Beats: show a relatable problem or frustration -> introduce the product -> show it solving the problem -> honest result.',
    'Talking creator, practical and conversational.',
  ].join('\n'),
}

const ASPECT_RATIO_OPTIONS = [
  { id: 'vertical_9x16', label: '9:16', helper: 'Portrait: 720x1280 or 1080x1920. TikTok, Reels, Stories.' },
  { id: 'square_1x1', label: '1:1', helper: 'Square: 720x720 or 1080x1080. Feed posts.' },
]
const PLATFORM_OPTIONS = ASPECT_RATIO_OPTIONS

const TONE_OPTIONS = [
  { id: 'casual-friend', label: 'Casual Friend', text: 'casual friend energy' },
  { id: 'skeptical-impressed', label: 'Won Over', text: 'skeptical at first, then genuinely impressed' },
  { id: 'excited-social', label: 'Excited Social', text: 'excited social creator energy' },
  { id: 'cozy-asmr', label: 'Cozy ASMR', text: 'slow cozy ASMR pacing' },
  { id: 'premium-creator', label: 'Premium Creator', text: 'premium but still phone-native creator style' },
  { id: 'funny-chaotic', label: 'Funny', text: 'playful funny chaotic UGC energy' },
]

const VIDEO_MODEL_OPTIONS = [
  { id: 'ltx23-i2v', label: 'LTX 2.3', helper: 'Default. Good for people-heavy shots and longer takes.' },
  { id: 'wan22-i2v', label: 'WAN 2.2', helper: 'Good alternate for product motion and physical demo shots.' },
  { id: SEEDANCE_UGC_VIDEO_WORKFLOW_ID, label: 'Seedance 2.0', helper: 'Cloud UGC pass. Generates spoken dialogue from the shot prompt.' },
]

const KEYFRAME_MODEL_OPTIONS = [
  {
    id: 'nano-banana-2',
    workflowId: 'nano-banana-2',
    label: 'Nano Banana 2',
    runtimeLabel: 'Cloud',
    source: 'cloud',
    tier: 'quality',
    helper: 'Current cloud keyframe route. Good for prompt-only ad storyboards and reference consistency.',
  },
  {
    id: 'image-edit-model-product',
    workflowId: 'image-edit-model-product',
    label: 'Qwen Image Edit',
    runtimeLabel: 'Local',
    source: 'local',
    tier: 'quality',
    needsReference: true,
    helper: 'Local keyframes using your product or creator reference as the edit source.',
  },
  {
    id: GPT_IMAGE_2_UGC_KEYFRAME_WORKFLOW_ID,
    workflowId: GPT_IMAGE_2_UGC_KEYFRAME_WORKFLOW_ID,
    label: 'GPT Image 2',
    runtimeLabel: 'Cloud',
    source: 'cloud',
    tier: 'quality',
    needsReference: true,
    helper: 'Cloud UGC keyframes using creator, product, and environment references.',
  },
  {
    id: CUSTOM_AD_KEYFRAME_WORKFLOW_ID,
    workflowId: CUSTOM_AD_KEYFRAME_WORKFLOW_ID,
    label: 'Custom Workflow',
    runtimeLabel: 'Advanced',
    source: 'local',
    tier: 'quality',
    helper: 'Run your own ComfyUI still-image graph for ad keyframes.',
  },
]

const SHOT_COUNT_OPTIONS = [3, 4, 5, 6, 8, 10, 12, 16, 20, 24]
const RESOLUTION_OPTIONS = [
  { id: '720p', label: '720p' },
  { id: '1080p', label: '1080p' },
]
const FPS_OPTIONS = [FIXED_UGC_FPS]
const HOOK_SUGGESTIONS = [
  'Wait. Look at this.',
  'I was today years old when...',
  'POV: you finally found it',
  'Nobody talks about this',
  'I did NOT expect this',
]
const UGC_HUMAN_THEME_CSS = `
  .ugc-human-theme {
    color: #f1efe8;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Arial, sans-serif;
  }
  .ugc-human-theme h2,
  .ugc-human-theme .ugc-editorial-title {
    font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
    letter-spacing: 0;
  }
  .ugc-human-theme [class*="rounded-2xl"],
  .ugc-human-theme [class*="rounded-xl"] {
    border-radius: 10px;
  }
  .ugc-human-theme [class*="rounded-lg"] {
    border-radius: 8px;
  }
  .ugc-human-theme [class*="border-sf-dark"],
  .ugc-human-theme [class*="border-cyan"],
  .ugc-human-theme [class*="border-fuchsia"],
  .ugc-human-theme [class*="border-emerald"],
  .ugc-human-theme [class*="border-amber"] {
    border-color: #2e2c26 !important;
  }
  .ugc-human-theme [class*="bg-sf-dark-950"] {
    background-color: #100f0d !important;
  }
  .ugc-human-theme [class*="bg-sf-dark-900"] {
    background-color: #161512 !important;
  }
  .ugc-human-theme [class*="bg-sf-dark-800"] {
    background-color: #23211d !important;
  }
  .ugc-human-theme [class*="bg-gradient-to-br"] {
    background: linear-gradient(135deg, #1b1a17 0%, #161512 56%, #23211d 100%) !important;
  }
  .ugc-human-theme [class*="text-sf-text-primary"] {
    color: #f1efe8 !important;
  }
  .ugc-human-theme [class*="text-sf-text-secondary"] {
    color: #c9c6ba !important;
  }
  .ugc-human-theme [class*="text-sf-text-muted"] {
    color: #95927f !important;
  }
  .ugc-human-theme [class*="text-cyan"],
  .ugc-human-theme [class*="text-fuchsia"],
  .ugc-human-theme [class*="text-sf-accent"] {
    color: #ffb4a3 !important;
  }
  .ugc-human-theme .ugc-primary {
    background: #ff4b2e !important;
    color: #fff !important;
  }
  .ugc-human-theme .ugc-primary:hover {
    background: #ff654c !important;
  }
  .ugc-human-theme .ugc-panel {
    border-color: #2e2c26 !important;
    background: #161512 !important;
  }
  .ugc-human-theme .ugc-card {
    border-color: #2e2c26 !important;
    background: #161512 !important;
  }
  .ugc-human-theme .ugc-input {
    border-color: #2e2c26 !important;
    background: #100f0d !important;
    color: #f1efe8 !important;
  }
  .ugc-human-theme .ugc-input:focus {
    border-color: #ff4b2e !important;
    outline: none !important;
  }
  .ugc-human-theme input::placeholder,
  .ugc-human-theme textarea::placeholder {
    color: #6b6859 !important;
  }
  .ugc-human-theme .ugc-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 18px;
  }
  .ugc-human-theme .ugc-crumb {
    color: #95927f;
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    letter-spacing: 0.02em;
    margin-bottom: 5px;
  }
  .ugc-human-theme .ugc-top-title {
    color: #f1efe8;
    font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
    font-size: 26px;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.15;
  }
  .ugc-human-theme .ugc-top-title span {
    color: #95927f;
    font-style: italic;
    font-weight: 400;
  }
  .ugc-human-theme .ugc-pill {
    align-items: center;
    background: #161512;
    border: 1px solid #2e2c26;
    border-radius: 6px;
    color: #c9c6ba;
    display: inline-flex;
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    gap: 7px;
    min-height: 30px;
    padding: 5px 12px;
    white-space: nowrap;
  }
  .ugc-human-theme .ugc-pill.hot {
    background: rgba(255, 75, 46, 0.12);
    border-color: rgba(255, 75, 46, 0.5);
    color: #ffb4a3;
    font-weight: 600;
  }
  .ugc-human-theme .ugc-dot {
    background: #46c275;
    border-radius: 999px;
    display: inline-block;
    height: 7px;
    width: 7px;
  }
  .ugc-human-theme .ugc-steps {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 18px;
  }
  .ugc-human-theme .ugc-step-btn {
    background: #161512;
    border: 1px solid #2e2c26;
    border-radius: 8px;
    color: #95927f;
    display: flex;
    flex: 1 1 150px;
    flex-direction: column;
    gap: 3px;
    padding: 10px 14px;
    text-align: left;
    transition: border-color 0.15s ease, color 0.15s ease, transform 0.12s ease;
  }
  .ugc-human-theme .ugc-step-btn:hover {
    border-color: #4a473e;
    color: #c9c6ba;
    transform: translateY(-1px);
  }
  .ugc-human-theme .ugc-step-btn.active {
    background: #1b1a17;
    border-color: #ff4b2e;
    color: #f1efe8;
  }
  .ugc-human-theme .ugc-step-btn.done {
    border-color: rgba(70, 194, 117, 0.4);
    color: #c9c6ba;
  }
  .ugc-human-theme .ugc-step-kicker {
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .ugc-human-theme .ugc-step-title {
    font-size: 14px;
    font-weight: 700;
  }
  .ugc-human-theme .ugc-layout {
    align-items: start;
    display: grid;
    gap: 18px;
    grid-template-columns: minmax(0, 1fr) 320px;
  }
  .ugc-human-theme .ugc-section-head {
    margin-bottom: 16px;
  }
  .ugc-human-theme .ugc-kicker {
    color: #ff4b2e;
    display: inline-block;
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.16em;
    margin-bottom: 10px;
    text-transform: uppercase;
  }
  .ugc-human-theme .ugc-section-title {
    color: #f1efe8;
    font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.15;
  }
  .ugc-human-theme .ugc-section-copy {
    color: #c9c6ba;
    font-size: 13px;
    line-height: 1.55;
    margin-top: 8px;
    max-width: 720px;
  }
  .ugc-human-theme .ugc-card-block {
    background: #161512;
    border: 1px solid #2e2c26;
    border-radius: 8px;
    padding: 16px;
  }
  .ugc-human-theme .ugc-card-title {
    color: #f1efe8;
    font-size: 14px;
    font-weight: 700;
    margin-bottom: 6px;
  }
  .ugc-human-theme .ugc-card-copy {
    color: #c9c6ba;
    font-size: 12px;
    line-height: 1.55;
  }
  .ugc-human-theme .ugc-format-grid {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    margin-top: 14px;
  }
  .ugc-human-theme .ugc-format-card {
    background: #1b1a17;
    border: 1px solid #2e2c26;
    border-radius: 8px;
    color: #c9c6ba;
    min-height: 132px;
    overflow: hidden;
    padding: 14px;
    position: relative;
    text-align: left;
    transition: border-color 0.15s ease, transform 0.12s ease;
  }
  .ugc-human-theme .ugc-format-card:hover {
    border-color: #4a473e;
    transform: translateY(-2px) rotate(-0.3deg);
  }
  .ugc-human-theme .ugc-format-card.selected {
    background: #23211d;
    border-color: #ff4b2e;
    color: #f1efe8;
  }
  .ugc-human-theme .ugc-format-card.selected::after {
    background: #ff4b2e;
    border-radius: 4px;
    color: #fff;
    content: "picked";
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    padding: 3px 7px;
    position: absolute;
    right: 10px;
    text-transform: uppercase;
    top: 10px;
  }
  .ugc-human-theme .ugc-format-emoji {
    display: block;
    font-size: 26px;
    margin-bottom: 8px;
  }
  .ugc-human-theme .ugc-format-name {
    color: #f1efe8;
    display: block;
    font-size: 14px;
    font-weight: 800;
  }
  .ugc-human-theme .ugc-format-desc {
    color: #c9c6ba;
    display: block;
    font-size: 11px;
    line-height: 1.45;
    margin-top: 4px;
  }
  .ugc-human-theme .ugc-hook-hero {
    background:
      linear-gradient(135deg, rgba(255,75,46,0.10), rgba(255,75,46,0.02)),
      #161512;
    border: 1px solid rgba(255, 75, 46, 0.35);
    border-radius: 8px;
    margin-top: 12px;
    padding: 16px;
  }
  .ugc-human-theme .ugc-hook-hero label,
  .ugc-human-theme .ugc-field-label {
    color: #95927f;
    display: block;
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 10px;
    letter-spacing: 0.12em;
    margin-bottom: 7px;
    text-transform: uppercase;
  }
  .ugc-human-theme .ugc-hook-input {
    background: #100f0d;
    border: 1px solid #4a473e;
    border-radius: 8px;
    color: #f1efe8;
    font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
    font-size: 24px;
    font-weight: 700;
    outline: none;
    padding: 10px 14px;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
    width: 100%;
  }
  .ugc-human-theme .ugc-hook-input:hover {
    border-color: #5f5a4e;
  }
  .ugc-human-theme .ugc-hook-input:focus {
    border-color: #ff4b2e;
    box-shadow: 0 0 0 3px rgba(255, 75, 46, 0.18);
  }
  .ugc-human-theme .ugc-hook-input::placeholder {
    color: #5f6877;
    font-style: italic;
    font-weight: 400;
  }
  .ugc-human-theme .ugc-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
  .ugc-human-theme .ugc-chip {
    background: #1b1a17;
    border: 1px solid #2e2c26;
    border-radius: 999px;
    color: #c9c6ba;
    font-size: 11px;
    padding: 6px 10px;
  }
  .ugc-human-theme .ugc-chip.active {
    background: rgba(255,75,46,0.12);
    border-color: rgba(255,75,46,0.45);
    color: #ffb4a3;
  }
  .ugc-human-theme .ugc-toggle-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .ugc-human-theme .ugc-toggle {
    background: #100f0d;
    border: 1px solid #2e2c26;
    border-radius: 6px;
    color: #c9c6ba;
    font-size: 12px;
    padding: 8px 10px;
  }
  .ugc-human-theme .ugc-toggle.selected {
    background: rgba(255,75,46,0.12);
    border-color: #ff4b2e;
    color: #f1efe8;
  }
  .ugc-human-theme .ugc-side-card {
    background: #161512;
    border: 1px solid #2e2c26;
    border-radius: 8px;
    padding: 14px;
  }
  .ugc-human-theme .ugc-side-card + .ugc-side-card {
    margin-top: 12px;
  }
  .ugc-human-theme .ugc-side-title {
    color: #f1efe8;
    font-size: 13px;
    font-weight: 800;
    margin-bottom: 10px;
  }
  .ugc-human-theme .ugc-side-heading {
    align-items: center;
    display: flex;
    gap: 10px;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .ugc-human-theme .ugc-side-heading .ugc-side-title {
    margin-bottom: 0;
  }
  .ugc-human-theme .ugc-preview-toggle {
    background: #100f0d;
    border: 1px solid #3b3833;
    border-radius: 6px;
    color: #c9c6ba;
    font-size: 10px;
    font-weight: 800;
    min-height: 28px;
    padding: 5px 9px;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    white-space: nowrap;
  }
  .ugc-human-theme .ugc-preview-toggle:hover:not(:disabled) {
    border-color: #ff4b2e;
    color: #f1efe8;
  }
  .ugc-human-theme .ugc-preview-toggle.active {
    background: rgba(255,75,46,0.14);
    border-color: #ff4b2e;
    color: #ffb4a3;
  }
  .ugc-human-theme .ugc-preview-toggle:disabled {
    cursor: not-allowed;
    opacity: 0.48;
  }
  .ugc-human-theme .preview-phone {
    aspect-ratio: 9 / 17.5;
    background: linear-gradient(170deg, #2c2620 0%, #1a2226 55%, #2a1f1b 100%);
    border: 3px solid #3b3833;
    border-radius: 26px;
    box-shadow: 0 18px 60px rgba(0,0,0,0.45);
    margin: 0 auto;
    overflow: hidden;
    position: relative;
    width: 210px;
  }
  .ugc-human-theme .preview-phone.has-video {
    background: #050505;
  }
  .ugc-human-theme .preview-phone.has-video::after {
    background: linear-gradient(180deg, rgba(0,0,0,0.24) 0%, rgba(0,0,0,0) 38%, rgba(0,0,0,0.72) 100%);
    content: "";
    inset: 0;
    pointer-events: none;
    position: absolute;
    z-index: 1;
  }
  .ugc-human-theme .pv-video {
    display: block;
    height: 100%;
    inset: 0;
    object-fit: cover;
    position: absolute;
    width: 100%;
    z-index: 0;
  }
  .ugc-human-theme .pv-video:-webkit-full-screen {
    object-fit: contain;
    position: static;
    height: 100%;
    width: 100%;
  }
  .ugc-human-theme .pv-video:fullscreen {
    object-fit: contain;
    position: static;
    height: 100%;
    width: 100%;
  }
  .ugc-human-theme .pv-sequence-badge {
    background: rgba(0,0,0,0.52);
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 999px;
    color: rgba(255,255,255,0.9);
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 8px;
    font-weight: 800;
    left: 10px;
    letter-spacing: 0.02em;
    padding: 4px 7px;
    position: absolute;
    text-transform: uppercase;
    top: 24px;
    z-index: 4;
  }
  .ugc-human-theme .preview-phone .notch,
  .ugc-human-theme .phone-shell .notch {
    background: rgba(0,0,0,0.7);
    border-radius: 999px;
    height: 11px;
    left: 50%;
    position: absolute;
    top: 8px;
    transform: translateX(-50%);
    width: 38%;
    z-index: 5;
  }
  .ugc-human-theme .pv-center {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 6px;
    inset: 0;
    justify-content: center;
    padding: 0 18px;
    position: absolute;
    text-align: center;
    z-index: 3;
  }
  .ugc-human-theme .pv-center .hook-line {
    color: #fff;
    font-size: 13px;
    font-weight: 800;
    line-height: 1.3;
    text-shadow: 0 2px 10px rgba(0,0,0,0.55);
  }
  .ugc-human-theme .pv-center .sub {
    color: rgba(255,255,255,0.75);
    font-size: 9px;
  }
  .ugc-human-theme .pv-actions {
    bottom: 64px;
    display: flex;
    flex-direction: column;
    font-size: 16px;
    gap: 12px;
    position: absolute;
    right: 8px;
    text-align: center;
    z-index: 4;
  }
  .ugc-human-theme .pv-actions .cnt {
    color: rgba(255,255,255,0.85);
    display: block;
    font-size: 8px;
    font-weight: 700;
  }
  .ugc-human-theme .pv-caption {
    bottom: 38px;
    color: #fff;
    font-size: 9.5px;
    left: 10px;
    line-height: 1.45;
    position: absolute;
    right: 52px;
    text-shadow: 0 1px 6px rgba(0,0,0,0.6);
    z-index: 4;
  }
  .ugc-human-theme .pv-caption .user {
    font-size: 10px;
    font-weight: 800;
  }
  .ugc-human-theme .pv-sound {
    align-items: center;
    bottom: 14px;
    color: rgba(255,255,255,0.9);
    display: flex;
    font-size: 9px;
    gap: 6px;
    left: 10px;
    overflow: hidden;
    position: absolute;
    right: 52px;
    white-space: nowrap;
    z-index: 4;
  }
  .ugc-human-theme .ugc-summary-list {
    display: grid;
    gap: 8px;
  }
  .ugc-human-theme .ugc-summary-item {
    align-items: center;
    border-bottom: 1px solid #2e2c26;
    color: #c9c6ba;
    display: flex;
    font-size: 11px;
    justify-content: space-between;
    padding-bottom: 7px;
  }
  .ugc-human-theme .ugc-summary-item:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }
  .ugc-human-theme .ugc-summary-label {
    color: #95927f;
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 10px;
    text-transform: uppercase;
  }
  .ugc-human-theme .ugc-tag-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .ugc-human-theme .ugc-tag {
    background: #1b1a17;
    border: 1px solid #2e2c26;
    border-radius: 4px;
    color: #95927f;
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 10px;
    font-weight: 700;
    padding: 4px 10px;
  }
  .ugc-human-theme .ugc-tag.pink {
    background: rgba(255,75,46,0.12);
    border-color: rgba(255,75,46,0.45);
    color: #ffb4a3;
  }
  .ugc-human-theme .ugc-tag.cyan {
    background: rgba(127,180,230,0.12);
    border-color: rgba(127,180,230,0.4);
    color: #b9d8f3;
  }
  .ugc-human-theme .ugc-tag.lime {
    background: rgba(70,194,117,0.12);
    border-color: rgba(70,194,117,0.4);
    color: #a9e3c0;
  }
  .ugc-human-theme .phone-grid {
    display: grid;
    gap: 14px;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    margin-top: 14px;
  }
  .ugc-human-theme .phone-card {
    background: transparent;
    border: 0;
    padding: 0;
    text-align: left;
  }
  .ugc-human-theme .phone-shell {
    aspect-ratio: 9 / 16;
    background: #1b1a17;
    border: 2px solid #4a473e;
    border-radius: 18px;
    display: block;
    overflow: hidden;
    position: relative;
    transition: border-color 0.15s ease, box-shadow 0.2s ease, transform 0.15s ease;
  }
  .ugc-human-theme .phone-card:hover .phone-shell {
    border-color: #6b6859;
    transform: translateY(-3px);
  }
  .ugc-human-theme .phone-card.selected .phone-shell {
    border-color: #ff4b2e;
  }
  .ugc-human-theme .phone-fill {
    align-items: center;
    color: #95927f;
    display: flex;
    font-size: 11px;
    inset: 0;
    justify-content: center;
    padding: 10px;
    position: absolute;
    text-align: center;
  }
  .ugc-human-theme .phone-fill.ready-1 { background: linear-gradient(160deg, #3a342c, #20292a); }
  .ugc-human-theme .phone-fill.ready-2 { background: linear-gradient(160deg, #28323a, #392c27); }
  .ugc-human-theme .phone-fill.ready-3 { background: linear-gradient(160deg, #3b3322, #232c34); }
  .ugc-human-theme .phone-fill.generating {
    background: linear-gradient(160deg, rgba(255,75,46,0.14), rgba(255,75,46,0.04));
  }
  .ugc-human-theme .phone-fill.generating::after {
    animation: ugc-shimmer 1.6s infinite;
    background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,0.10) 50%, transparent 70%);
    content: "";
    inset: 0;
    position: absolute;
  }
  @keyframes ugc-shimmer {
    from { transform: translateX(-100%); }
    to { transform: translateX(100%); }
  }
  .ugc-human-theme .phone-status {
    border-radius: 4px;
    bottom: 8px;
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 9px;
    font-weight: 700;
    left: 8px;
    letter-spacing: 0.08em;
    padding: 3px 8px;
    position: absolute;
    text-transform: uppercase;
    z-index: 3;
  }
  .ugc-human-theme .phone-status.ready { background: #46c275; color: #0f1410; }
  .ugc-human-theme .phone-status.generating { background: rgba(232,72,46,0.95); color: #fff; }
  .ugc-human-theme .phone-status.pending { background: rgba(0,0,0,0.55); border: 1px solid #2e2c26; color: #95927f; }
  .ugc-human-theme .phone-status.blocked { background: rgba(255,194,75,0.9); color: #100f0d; }
  .ugc-human-theme .phone-status.error { background: rgba(239,68,68,0.95); color: #fff; }
  .ugc-human-theme .phone-meta {
    display: block;
    margin-top: 7px;
  }
  .ugc-human-theme .phone-meta .shot-name {
    color: #f1efe8;
    display: block;
    font-size: 12px;
    font-weight: 800;
  }
  .ugc-human-theme .phone-meta .shot-line {
    color: #95927f;
    display: block;
    font-size: 10px;
    line-height: 1.4;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ugc-human-theme .phone-progress {
    background: #23211d;
    border-radius: 999px;
    display: block;
    height: 4px;
    margin-top: 6px;
    overflow: hidden;
  }
  .ugc-human-theme .phone-progress > * {
    background: #ff4b2e;
    border-radius: 999px;
    display: block;
    height: 100%;
  }
  @media (max-width: 1080px) {
    .ugc-human-theme .ugc-layout {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 620px) {
    .ugc-human-theme .ugc-topbar {
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .ugc-human-theme .ugc-steps {
      display: grid;
      grid-template-columns: 1fr;
    }
    .ugc-human-theme .ugc-hook-input {
      font-size: 20px;
    }
  }
`
const KEYFRAME_BUSY_STATUSES = new Set(['queued', 'paused', 'uploading', 'configuring', 'queuing', 'running', 'saving'])
const VIDEO_BUSY_STATUSES = KEYFRAME_BUSY_STATUSES
const UGC_AD_DRAFT_STORAGE_KEY = 'comfystudio-ugc-ad-creator-draft-v1'
const DEFAULT_UGC_AD_DRAFT = Object.freeze({
  // Product-/brand-/setting-specific fields start blank so the placeholders show and
  // the user fills in their own. Only the universal, product-agnostic defaults below
  // (camera rules, creator direction) are pre-set.
  businessName: '',
  productService: '',
  hook: '',
  audience: '',
  offer: '',
  proof: '',
  cta: '',
  destination: '',
  location: '',
  visualRules: 'shot on iPhone, vertical 9:16, handheld micro-shake, real skin tones, warm natural light, no studio polish, no text overlays',
  talentDirection: 'young creator talking directly to camera, relaxed and genuine, like showing a friend',
  goal: 'casual_review',
  platform: 'vertical_9x16',
  tone: 'casual-friend',
  resolutionPreset: '720p',
  videoFps: FIXED_UGC_FPS,
  commercialLength: 15,
  shotCount: 5,
  keyframeWorkflowId: 'nano-banana-2',
  videoWorkflowId: 'ltx23-i2v',
  voiceMode: 'generate',
  voiceId: 'Jessica (female, american)',
  voiceModel: 'eleven_v3',
  voiceStability: 0.4,
  voiceDelivery: {},
  productAssetId: '',
  talentAssetId: '',
  environmentAssetId: '',
  noVisibleTalent: false,
  directorScript: '',
  scriptManuallyEdited: false,
})

function normalizeDraftOption(value, options, fallback) {
  const normalized = String(value || '').trim()
  return options.some((option) => option?.id === normalized) ? normalized : fallback
}

function normalizeDraftNumber(value, allowedValues, fallback) {
  const parsed = Number(value)
  return allowedValues.includes(parsed) ? parsed : fallback
}

function normalizeDraftRangeNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function normalizeUgcAdDraft(rawDraft = {}) {
  const raw = rawDraft && typeof rawDraft === 'object' ? rawDraft : {}
  return {
    businessName: String(raw.businessName || DEFAULT_UGC_AD_DRAFT.businessName),
    productService: String(raw.productService || DEFAULT_UGC_AD_DRAFT.productService),
    hook: String(raw.hook || DEFAULT_UGC_AD_DRAFT.hook),
    audience: String(raw.audience || DEFAULT_UGC_AD_DRAFT.audience),
    offer: String(raw.offer || DEFAULT_UGC_AD_DRAFT.offer),
    proof: String(raw.proof || DEFAULT_UGC_AD_DRAFT.proof),
    cta: String(raw.cta || DEFAULT_UGC_AD_DRAFT.cta),
    destination: String(raw.destination || DEFAULT_UGC_AD_DRAFT.destination),
    location: String(raw.location || DEFAULT_UGC_AD_DRAFT.location),
    visualRules: String(raw.visualRules || DEFAULT_UGC_AD_DRAFT.visualRules),
    talentDirection: String(raw.talentDirection || DEFAULT_UGC_AD_DRAFT.talentDirection),
    goal: normalizeDraftOption(raw.goal, UGC_FORMAT_OPTIONS, DEFAULT_UGC_AD_DRAFT.goal),
    platform: normalizeDraftOption(raw.platform, PLATFORM_OPTIONS, DEFAULT_UGC_AD_DRAFT.platform),
    tone: normalizeDraftOption(raw.tone, TONE_OPTIONS, DEFAULT_UGC_AD_DRAFT.tone),
    resolutionPreset: normalizeDraftOption(raw.resolutionPreset, RESOLUTION_OPTIONS, DEFAULT_UGC_AD_DRAFT.resolutionPreset),
    videoFps: normalizeDraftNumber(raw.videoFps, FPS_OPTIONS, DEFAULT_UGC_AD_DRAFT.videoFps),
    commercialLength: normalizeDraftRangeNumber(raw.commercialLength, DEFAULT_UGC_AD_DRAFT.commercialLength, MIN_UGC_LENGTH_SECONDS, MAX_UGC_LENGTH_SECONDS),
    shotCount: normalizeDraftNumber(raw.shotCount, SHOT_COUNT_OPTIONS, DEFAULT_UGC_AD_DRAFT.shotCount),
    keyframeWorkflowId: normalizeDraftOption(raw.keyframeWorkflowId, KEYFRAME_MODEL_OPTIONS, DEFAULT_UGC_AD_DRAFT.keyframeWorkflowId),
    videoWorkflowId: normalizeDraftOption(raw.videoWorkflowId, VIDEO_MODEL_OPTIONS, DEFAULT_UGC_AD_DRAFT.videoWorkflowId),
    voiceMode: ['none', 'generate'].includes(String(raw.voiceMode)) ? String(raw.voiceMode) : DEFAULT_UGC_AD_DRAFT.voiceMode,
    voiceId: VOICE_OPTIONS.includes(String(raw.voiceId)) ? String(raw.voiceId) : DEFAULT_UGC_AD_DRAFT.voiceId,
    voiceModel: VOICE_MODEL_OPTIONS.some((option) => option.id === String(raw.voiceModel)) ? String(raw.voiceModel) : DEFAULT_UGC_AD_DRAFT.voiceModel,
    voiceStability: normalizeDraftRangeNumber(typeof raw.voiceStability === 'number' ? raw.voiceStability * 100 : NaN, DEFAULT_UGC_AD_DRAFT.voiceStability * 100, 0, 100) / 100,
    voiceDelivery: (raw.voiceDelivery && typeof raw.voiceDelivery === 'object') ? raw.voiceDelivery : {},
    productAssetId: String(raw.productAssetId || ''),
    talentAssetId: String(raw.talentAssetId || ''),
    environmentAssetId: String(raw.environmentAssetId || ''),
    noVisibleTalent: Boolean(raw.noVisibleTalent),
    directorScript: String(raw.directorScript || ''),
    scriptManuallyEdited: Boolean(raw.scriptManuallyEdited),
  }
}

function loadUgcAdDraft() {
  if (typeof localStorage === 'undefined') return DEFAULT_UGC_AD_DRAFT
  try {
    const raw = localStorage.getItem(UGC_AD_DRAFT_STORAGE_KEY)
    if (!raw) return DEFAULT_UGC_AD_DRAFT
    return normalizeUgcAdDraft(JSON.parse(raw))
  } catch (_) {
    return DEFAULT_UGC_AD_DRAFT
  }
}

function getSuggestedShotCount(length) {
  const seconds = normalizeDraftRangeNumber(length, DEFAULT_UGC_AD_DRAFT.commercialLength, MIN_UGC_LENGTH_SECONDS, MAX_UGC_LENGTH_SECONDS)
  // ~1 spoken beat per 5s so each line has room to land (was /3, which crammed
  // ~6 lines into 15s and clipped the last one).
  const roughCount = Math.max(3, Math.min(24, Math.round(seconds / 5)))
  return SHOT_COUNT_OPTIONS.reduce((best, option) => (
    Math.abs(option - roughCount) < Math.abs(best - roughCount) ? option : best
  ), SHOT_COUNT_OPTIONS[0])
}

function getShotHint(length) {
  const seconds = normalizeDraftRangeNumber(length, DEFAULT_UGC_AD_DRAFT.commercialLength, MIN_UGC_LENGTH_SECONDS, MAX_UGC_LENGTH_SECONDS)
  const suggestedCount = getSuggestedShotCount(seconds)
  const recommendation = seconds < RECOMMENDED_UGC_LENGTH_MIN || seconds > RECOMMENDED_UGC_LENGTH_MAX
    ? `UGC usually lands best around ${RECOMMENDED_UGC_LENGTH_MIN}-${RECOMMENDED_UGC_LENGTH_MAX}s.`
    : 'This is in the sweet spot for UGC.'
  return `${recommendation} Suggested: about ${suggestedCount} shots at roughly ${getShotDuration(suggestedCount, seconds)}s each.`
}

function formatShotTime(index, count, totalSeconds) {
  const start = Math.round((index * totalSeconds) / count)
  const end = Math.round(((index + 1) * totalSeconds) / count)
  return `${start}-${Math.max(end, start + 1)}s`
}

function getShotDuration(count, totalSeconds) {
  const duration = Math.max(2, Math.min(5, Number(totalSeconds || 30) / Math.max(1, Number(count) || 1)))
  return Number(duration.toFixed(1))
}

function resolveOutputResolution(platform, resolutionPreset) {
  const is1080 = resolutionPreset === '1080p'
  if (platform === 'landscape_16x9') {
    return is1080 ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }
  }
  if (platform === 'square_1x1') {
    return is1080 ? { width: 1080, height: 1080 } : { width: 720, height: 720 }
  }
  return is1080 ? { width: 1080, height: 1920 } : { width: 720, height: 1280 }
}

function formatResolutionLabel(resolution) {
  if (!resolution) return ''
  return `${resolution.width}x${resolution.height}`
}

function getAssetUrl(asset) {
  return asset?.url || asset?.thumbnailUrl || asset?.proxyUrl || asset?.path || ''
}

function getVideoVariantWorkflowKey(variantKey, workflowId) {
  const key = String(variantKey || '').trim()
  const workflow = String(workflowId || '').trim()
  return key && workflow ? `${key}::${workflow}` : ''
}

function compact(text, fallback) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value || fallback
}

function buildShotTemplates(data) {
  const product = compact(data.productService || data.product, 'the product')
  const brand = compact(data.businessName || data.brand, 'the brand')
  const hook = compact(data.hook, `Okay, I need to show you this ${product}.`)
  const audience = compact(data.audience, 'the viewer')
  const promise = compact(data.offer || data.promise, 'the main product reason to care')
  const proof = compact(data.proof, 'one believable proof moment')
  const visualRules = compact(data.visualRules || data.colors, 'phone-native vertical UGC, natural light, no filters')
  const creator = data.noVisibleTalent
    ? 'hands-only creator, no face visible'
    : compact(data.talentDirection, 'creator talking naturally to camera like showing a friend')
  const environmentCue = data.environmentReferenceName
    ? ` Use the provided environment reference (${data.environmentReferenceName}) as the room/location anchor and match its surfaces, lighting, colors, and background continuity.`
    : ''
  const baseStyle = `${visualRules}.${environmentCue} No rendered text, no watermark, no fake captions.`
  const shot = (title, adBeat, productMode, talentMode, shotType, dialogue, productAction, camera, keyframe, motion) => ({
    title,
    adBeat,
    productMode,
    talentMode,
    shotType,
    dialogue,
    productAction,
    camera,
    keyframe,
    motion,
  })

  const format = data.goal || 'casual_review'
  const sets = {
    casual_review: [
      shot(
        'Selfie hook',
        'hook',
        'in-hand',
        'creator',
        'selfie close-up',
        `"${stripDialogueQuotes(hook)}"`,
        'Creator holds the product up to the front camera like showing a friend.',
        'iPhone front camera, vertical, handheld micro-shake',
        `Selfie-style UGC keyframe of ${creator} holding ${product} close to camera, casual authentic expression, ${baseStyle}`,
        'Creator brings the product toward the lens, tilts it once, and speaks naturally.'
      ),
      shot(
        'First impression',
        'product reveal',
        'hero',
        'creator hands',
        'back camera close-up',
        `"The first thing I noticed was this."`,
        'Creator switches to back camera and shows the product detail or packaging.',
        'Back camera close-up, natural focus shift',
        `Back-camera UGC close-up keyframe of ${product}, product readable in hand, real daylight and slight phone-lens perspective, ${baseStyle}`,
        'Camera moves close, focus settles on the product, creator points out one detail.'
      ),
      shot(
        'Try it',
        'demo',
        'in-use',
        'creator',
        'medium demo shot',
        `"I wanted to see if it actually works."`,
        `Creator uses ${product} in the real environment.`,
        'Phone propped up or handheld, casual medium shot',
        `UGC demo keyframe of ${creator} using ${product} naturally in a real setting, ${baseStyle}`,
        'Creator uses the product once clearly, keeping the action simple and believable.'
      ),
      shot(
        'Honest reaction',
        'reaction',
        'result',
        'creator',
        'selfie reaction',
        `"Okay, that is better than I expected."`,
        'Creator reacts to the result, product still visible.',
        'Front camera reaction, small exposure shifts',
        `Selfie UGC reaction keyframe of ${creator} reacting to the result from ${product}, honest friend-like expression, ${baseStyle}`,
        'Creator looks at the product, then back to camera, with a genuine small reaction.'
      ),
      shot(
        'Final recommendation',
        'CTA',
        'hero',
        'creator',
        'selfie product hold',
        `"Yeah. I would actually use this."`,
        'Creator holds the product beside face for final recommendation.',
        'Front camera final hold',
        `Final UGC keyframe of ${creator} holding ${product} beside face, relaxed recommendation energy, ${baseStyle}`,
        'Creator gives a casual final nod, product readable, ending like a real social post.'
      ),
    ],
    unboxing_asmr: [
      shot(
        'Box tap and open',
        'hook',
        'packaging reveal',
        'hands only',
        'overhead top-down',
        'No spoken line, just a quiet satisfying product reveal.',
        'Hands tap the box, lift the lid, and reveal the inner wrapping.',
        'Overhead top-down phone camera, slow deliberate ASMR movement',
        `Overhead UGC unboxing keyframe of ${product} packaging centered on a clean desk or counter, hands visible, cozy natural light, tactile product setup, ${baseStyle}`,
        'Hands tap the package, open it slowly, and reveal the inside with crisp tactile ASMR movement.'
      ),
      shot(
        'First reveal',
        'product reveal',
        'hero',
        'hands only',
        'close-up insert',
        '"Wait, this is actually so nice."',
        'Hands peel wrapping or open the product and pause on the first reveal.',
        'Top-down close-up with slight handheld drift',
        `Close-up UGC keyframe of hands revealing ${product} from packaging, product clearly visible for the first time, warm natural light, ${baseStyle}`,
        'Slow peel or lift reveal, pause for the satisfying first-look moment, product stays centered.'
      ),
      shot(
        'Texture check',
        'demo',
        'macro detail',
        'hands only',
        'macro close-up',
        '"Okay, the details are kind of perfect."',
        'Hands tilt, tap, touch, or rotate the product to show material and details.',
        'Back camera macro, very close, tactile and slow',
        `Macro UGC product detail keyframe for ${product}, hands showing texture, material, label, surface, or finish, ${baseStyle}`,
        'Hands rotate and tap the product detail slowly, keeping every texture readable and satisfying.'
      ),
      shot(
        'Extras and layout',
        'proof',
        'accessories',
        'hands only',
        'overhead layout',
        '"You get all of this in the box."',
        'Hands lay out accessories, cards, attachments, or packaging pieces around the product.',
        'Overhead layout shot',
        `Overhead UGC layout keyframe with ${product} and included pieces arranged neatly on a desk, hands at edge of frame, ${baseStyle}`,
        'Hands slide each item into place, align the layout, and keep the product as the center of attention.'
      ),
      shot(
        'Final display',
        'CTA',
        'beauty display',
        'hands only',
        'locked beauty shot',
        `"That's it. That's the unboxing."`,
        'Hands pull away and leave the product in a final display arrangement.',
        'Overhead locked phone shot with tiny natural movement',
        `Final UGC unboxing display keyframe for ${product}, open packaging behind it, product arranged neatly in warm natural light, ${baseStyle}`,
        'Hands pull away, hold on the final beauty display, slow quiet ASMR finish.'
      ),
    ],
    demo_review: [
      shot(
        'Direct hook',
        'hook',
        'in-hand',
        'creator',
        'selfie close-up',
        `"This ${product} just changed my routine."`,
        'Creator holds the product close to the selfie camera.',
        'iPhone front camera, vertical, handheld micro-shake',
        `Selfie-style UGC keyframe of ${creator} holding ${product} close to camera, eyes engaged, casual room or use environment, ${baseStyle}`,
        'Creator brings the product toward the lens, reacts naturally, and keeps it readable.'
      ),
      shot(
        'Feature touch',
        'demo',
        'feature detail',
        'creator hands',
        'back camera close-up',
        '"This part is what surprised me."',
        'Finger taps, turns, opens, applies, or points to the main feature.',
        'Back camera close-up with slight exposure shifts',
        `Back-camera UGC close-up keyframe of hands demonstrating the main feature of ${product}, product detail fills frame, ${baseStyle}`,
        'Finger traces the feature, taps or turns it, then pauses for a clear detail moment.'
      ),
      shot(
        'Use it for real',
        'demo',
        'in-use',
        'creator',
        'medium handheld',
        `"It is honestly way easier than I expected."`,
        `Creator uses ${product} in the real environment for ${audience}.`,
        'Phone propped up, medium shot, natural handheld feel',
        `UGC medium keyframe of ${creator} using ${product} naturally, believable real-life demo moment for ${audience}, ${baseStyle}`,
        'Creator uses the product in one simple real action from start to finish.'
      ),
      shot(
        'Result reaction',
        'proof',
        'result',
        'creator',
        'selfie reaction',
        `"Okay, I get it now."`,
        'Creator checks the result and gives an honest small reaction.',
        'Front camera reaction shot',
        `Selfie UGC reaction keyframe of ${creator} responding to the result from ${product}, natural smile or surprised expression, ${baseStyle}`,
        'Creator looks from product to camera with a genuine reaction, not overacted.'
      ),
      shot(
        'Final verdict',
        'CTA',
        'hero',
        'creator',
        'selfie product hold',
        `"Yeah. I would actually recommend this."`,
        'Creator holds product beside face for final recommendation.',
        'Front camera, casual final hold',
        `Final UGC keyframe of ${creator} holding ${product} beside their face, calm recommendation energy, ${baseStyle}`,
        'Creator gives a small nod, holds product readable, and finishes like a real social post.'
      ),
    ],
    try_on_grwm: [
      shot(
        'Getting ready hook',
        'hook',
        'in-hand',
        'creator',
        'mirror-free selfie',
        '"Okay, I am getting ready and I need to try this."',
        'Creator brings the product or wearable item into frame.',
        'iPhone front camera, casual room, handheld',
        `Selfie UGC get-ready keyframe of ${creator} introducing ${product} in a real room, playful getting-ready energy, ${baseStyle}`,
        'Creator steps into frame, adjusts outfit or product, and talks naturally to camera.'
      ),
      shot(
        'Put it on',
        'demo',
        'try-on',
        'creator',
        'medium close-up',
        '"I did not expect it to look this good."',
        'Creator applies, wears, clips, carries, or styles the product.',
        'Front camera with natural exposure flicker',
        `UGC try-on keyframe of ${creator} wearing or applying ${product}, product visible, natural skin texture and real room light, ${baseStyle}`,
        'Creator puts on or adjusts the product, checking it naturally in-camera.'
      ),
      shot(
        'Detail check',
        'proof',
        'detail',
        'creator hands',
        'close-up',
        '"Look at the detail though."',
        'Creator brings the product detail close to the lens.',
        'Back camera or front camera close-up',
        `Close-up UGC keyframe of ${product} detail while worn or held, realistic reflections, texture, and fit, ${baseStyle}`,
        'Creator rotates or adjusts the product so the detail catches light naturally.'
      ),
      shot(
        'Full look',
        'lifestyle',
        'lifestyle',
        'creator',
        'fuller body shot',
        '"It is a little bold, but it works."',
        'Creator steps back to show the whole look or full product context.',
        'Phone propped up, natural room perspective',
        `UGC full-look keyframe of ${creator} showing ${product} in context, casual room, confident natural pose, ${baseStyle}`,
        'Creator steps back, does a quick natural pose or turn, and keeps the product visible.'
      ),
      shot(
        'Decision',
        'CTA',
        'hero',
        'creator',
        'selfie close-up',
        `"I'm wearing this."`,
        'Creator gives the final approving look.',
        'Front camera final reaction',
        `Final selfie UGC keyframe of ${creator} with ${product}, confident friendly final reaction, ${baseStyle}`,
        'Creator smiles or nods to camera, ending mid-motion like a real social clip.'
      ),
    ],
    mini_testimonial: [
      shot(
        'Daily use hook',
        'hook',
        'in-hand',
        'creator',
        'selfie close-up',
        `"I have been using this every day lately."`,
        'Creator casually holds product while sitting or standing in a real room.',
        'Front camera, intimate low-key framing',
        `Selfie UGC testimonial keyframe of ${creator} holding ${product} naturally, warm room light, real skin tones, ${baseStyle}`,
        'Creator talks calmly to camera and casually rotates the product in hand.'
      ),
      shot(
        'Why it stuck',
        'benefit',
        'in-use',
        'creator',
        'medium shot',
        `"I did not expect to like it this much."`,
        `Creator shows the simple habit or routine where ${product} fits.`,
        'Phone propped up, casual daily routine shot',
        `UGC daily routine keyframe of ${creator} using ${product} in a believable everyday moment, ${baseStyle}`,
        'Creator uses the product casually while explaining why it became part of their routine.'
      ),
      shot(
        'Proof detail',
        'proof',
        'detail',
        'creator hands',
        'close-up insert',
        `"This is the part that sold me."`,
        'Creator shows one concrete proof detail.',
        'Back camera close-up',
        `Close-up testimonial proof keyframe for ${product}, creator hands showing the most believable feature or result, ${baseStyle}`,
        'Creator points out the detail, taps or demonstrates it, then holds it still.'
      ),
      shot(
        'Honest verdict',
        'testimonial',
        'lifestyle',
        'creator',
        'selfie medium close-up',
        `"I just end up taking it with me everywhere now."`,
        'Creator gives a calm honest recommendation.',
        'Front camera, relaxed eye contact',
        `UGC testimonial keyframe of ${creator} speaking honestly to camera with ${product} visible, ${baseStyle}`,
        'Creator speaks naturally, small pauses and breaths, no overacted smile.'
      ),
      shot(
        'Soft CTA',
        'CTA',
        'hero',
        'creator',
        'selfie final hold',
        `"If you were thinking about it, this is your sign."`,
        'Creator holds product to camera one last time.',
        'Front camera final product hold',
        `Final UGC testimonial keyframe of ${creator} holding ${product} close to the lens, friendly final recommendation, ${baseStyle}`,
        'Creator brings product forward, smiles lightly, and ends like a real phone clip.'
      ),
    ],
    reaction_hook: [
      shot(
        'Wait look at this',
        'hook',
        'in-hand',
        'creator',
        'selfie close-up',
        '"Wait. Wait, look at this."',
        'Creator holds product very close and pauses for curiosity.',
        'Front camera, slightly too close in a real UGC way',
        `Selfie UGC reaction keyframe of ${creator} holding ${product} close to camera with surprised eyes, ${baseStyle}`,
        'Creator leans toward camera and brings product into frame with a genuine surprised reaction.'
      ),
      shot(
        'Satisfying action',
        'demo',
        'motion detail',
        'creator hands',
        'macro close-up',
        '"I cannot stop doing this."',
        'Creator tilts, shakes, opens, presses, pours, peels, or taps the most satisfying part.',
        'Back camera macro, handheld',
        `Macro UGC keyframe of ${product} doing its most satisfying visual action, hands visible, ${baseStyle}`,
        'Product action repeats slowly so the satisfying movement is clear and readable.'
      ),
      shot(
        'Closer proof',
        'proof',
        'detail',
        'creator hands',
        'extreme close-up',
        `"There is so much detail in here."`,
        'Creator brings the proof detail even closer to the lens.',
        'Back camera extreme close-up',
        `Extreme close-up UGC proof keyframe for ${product}, tactile details visible, realistic phone focus, ${baseStyle}`,
        'Camera pushes closer, focus hunts slightly, then settles on the product detail.'
      ),
      shot(
        'Creator reaction',
        'reaction',
        'lifestyle',
        'creator',
        'selfie medium close-up',
        `"This is genuinely the most satisfying thing I own right now."`,
        'Creator reacts naturally while still holding the product.',
        'Front camera with handheld drift',
        `UGC reaction keyframe of ${creator} smiling or laughing naturally with ${product}, real room light, ${baseStyle}`,
        'Creator reacts, looks from product to lens, and gives a genuine little laugh or nod.'
      ),
      shot(
        'That is the review',
        'CTA',
        'hero',
        'creator',
        'selfie product hold',
        `"That's it. That's the review."`,
        'Creator holds product beside face for final memorable frame.',
        'Front camera final hold',
        `Final UGC reaction keyframe of ${creator} holding ${product} beside face, playful satisfied expression, ${baseStyle}`,
        'Creator holds the product still, smiles at camera, and ends casually mid-motion.'
      ),
    ],
    problem_solution: [
      shot(
        'Problem hook',
        'problem',
        'context',
        'creator',
        'selfie close-up',
        `"I was getting so tired of this."`,
        'Creator shows the problem or frustration before product use.',
        'Front camera, honest close-up',
        `UGC problem hook keyframe of ${creator} showing the everyday problem ${product} solves for ${audience}, ${baseStyle}`,
        'Creator talks directly to camera, showing the problem without overacting.'
      ),
      shot(
        'Bring in solution',
        'product reveal',
        'in-hand',
        'creator',
        'selfie product reveal',
        `"So I tried this."`,
        'Creator brings the product into frame.',
        'Front camera, quick reveal',
        `Selfie UGC product reveal keyframe of ${creator} bringing ${product} into frame as the solution, ${baseStyle}`,
        'Creator lifts product into frame and holds it close enough to be recognizable.'
      ),
      shot(
        'Quick demo',
        'demo',
        'in-use',
        'creator',
        'medium demo shot',
        `"It took me like two seconds."`,
        'Creator uses the product in a simple visible action.',
        'Phone propped up or handheld back camera',
        `UGC demo keyframe of ${creator} using ${product} to solve the problem, simple real-life action, ${baseStyle}`,
        'Creator performs the product action once cleanly, keeping the result visible.'
      ),
      shot(
        'Result proof',
        'proof',
        'result',
        'creator',
        'close-up result',
        `"That is so much better."`,
        'Creator shows the immediate result or payoff.',
        'Back camera or selfie close-up',
        `UGC result proof keyframe for ${product}, clear visual payoff connected to ${promise}, ${baseStyle}`,
        'Camera holds on the result, then creator reacts naturally.'
      ),
      shot(
        'Simple CTA',
        'CTA',
        'hero',
        'creator',
        'selfie final hold',
        `"If you have the same problem, try this."`,
        'Creator gives a casual final recommendation.',
        'Front camera final hold',
        `Final UGC problem-solution keyframe of ${creator} holding ${product}, casual recommendation to ${audience}, ${baseStyle}`,
        'Creator points or nods subtly, product remains readable, casual social finish.'
      ),
    ],
  }

  return sets[format] || sets.casual_review
}

function getNormalizedShotCount(value) {
  return Math.max(3, Math.min(Number(value) || 5, 24))
}

function selectShotTemplates(templates, requestedCount) {
  const targetCount = getNormalizedShotCount(requestedCount)
  if (targetCount >= templates.length) return templates.slice()
  if (targetCount <= 1) return templates.slice(0, 1)

  const lastIndex = templates.length - 1
  return Array.from({ length: targetCount }, (_, index) => {
    const sourceIndex = Math.round((index * lastIndex) / (targetCount - 1))
    return templates[sourceIndex]
  })
}

function buildSupplementalShotTemplates(data) {
  const product = compact(data.productService || data.product, 'the product')
  const audience = compact(data.audience, 'the viewer')
  const proof = compact(data.proof, 'one believable proof moment')
  const visualRules = compact(data.visualRules || data.colors, 'phone-native vertical UGC, natural light, no filters')
  const creator = data.noVisibleTalent
    ? 'hands-only creator, no face visible'
    : compact(data.talentDirection, 'creator talking naturally to camera like showing a friend')
  const environmentCue = data.environmentReferenceName
    ? ` Use the provided environment reference (${data.environmentReferenceName}) as the room/location anchor and match its surfaces, lighting, colors, and background continuity.`
    : ''
  const baseStyle = `${visualRules}.${environmentCue} No rendered text, no watermark, no fake captions.`
  const shot = (title, adBeat, productMode, talentMode, shotType, dialogue, productAction, camera, keyframe, motion) => ({
    title,
    adBeat,
    productMode,
    talentMode,
    shotType,
    dialogue,
    productAction,
    camera,
    keyframe,
    motion,
  })

  const unboxingShots = [
    shot(
      'Seal close-up',
      'demo',
      'packaging detail',
      'hands only',
      'macro close-up',
      'No spoken line, just a crisp tactile packaging moment.',
      'Hands peel, lift, or open a small packaging detail slowly.',
      'Overhead macro phone shot',
      `Macro UGC unboxing keyframe of hands opening a small detail on ${product} packaging, tactile surface visible, ${baseStyle}`,
      'Hands peel or lift the detail slowly, pause on the texture, and keep the product centered.'
    ),
    shot(
      'In-hand reveal',
      'product reveal',
      'in-hand',
      'hands only',
      'close-up insert',
      '"This feels nicer than I expected."',
      'Hands lift the product out and rotate it once.',
      'Back camera close-up with warm natural light',
      `Close-up UGC keyframe of hands lifting ${product} out of packaging and rotating it, ${baseStyle}`,
      'Hands lift the product, rotate it once slowly, and settle into a readable hold.'
    ),
    shot(
      'Sound detail',
      'proof',
      'macro detail',
      'hands only',
      'overhead close-up',
      'No spoken line, product sounds and movement only.',
      'Hands tap, click, slide, or arrange the most satisfying physical detail.',
      'Overhead close-up, tiny handheld drift',
      `Tactile ASMR UGC keyframe of hands tapping, clicking, or sliding ${product}, satisfying material detail, ${baseStyle}`,
      'Hands repeat one satisfying motion twice, slow enough that the product detail stays readable.'
    ),
  ]

  const tryOnShots = [
    shot(
      'Fit check',
      'proof',
      'try-on',
      'creator',
      'medium try-on shot',
      '"Okay, this actually works."',
      'Creator checks fit, comfort, color, or styling in-camera.',
      'Phone propped up, natural room angle',
      `UGC try-on fit-check keyframe of ${creator} wearing or styling ${product}, product clearly visible, ${baseStyle}`,
      'Creator adjusts the product, steps back slightly, and checks the look naturally.'
    ),
    shot(
      'Movement check',
      'demo',
      'lifestyle',
      'creator',
      'handheld medium shot',
      '"It still feels comfortable when I move."',
      'Creator moves naturally so the product can be seen in use.',
      'Front camera with slight exposure flicker',
      `UGC movement-check keyframe of ${creator} using or wearing ${product} in a real room, ${baseStyle}`,
      'Creator turns, walks, lifts, or gestures once so the product moves naturally on camera.'
    ),
    shot(
      'Detail close-up',
      'proof',
      'detail',
      'creator hands',
      'close-up insert',
      '"This little detail is what sold me."',
      'Creator brings one detail close to the lens.',
      'Back camera close-up',
      `Close-up UGC try-on detail keyframe of ${product}, creator hands showing material, fit, texture, or finish, ${baseStyle}`,
      'Creator rotates or touches the detail, lets focus settle, then pulls back slightly.'
    ),
  ]

  const genericShots = [
    shot(
      'Proof close-up',
      'proof',
      'detail',
      'creator hands',
      'back camera close-up',
      '"This is the part that convinced me."',
      `Creator shows ${proof} in a clear close-up.`,
      'Back camera close-up, natural focus hunt',
      `UGC proof close-up keyframe for ${product}, hands showing ${proof}, created for ${audience}, ${baseStyle}`,
      'Camera pushes close, focus settles on the proof detail, and creator points to it once.'
    ),
    shot(
      'Second use',
      'demo',
      'in-use',
      'creator',
      'medium handheld',
      '"I wanted to try it one more way."',
      `Creator uses ${product} in a second simple real-life action.`,
      'Phone propped up or handheld medium shot',
      `UGC second-use keyframe of ${creator} using ${product} in another believable everyday moment, ${baseStyle}`,
      'Creator performs a second simple product action, keeping the movement clear and unpolished.'
    ),
    shot(
      'Texture moment',
      'detail',
      'macro detail',
      'creator hands',
      'macro close-up',
      '"The texture is really nice."',
      'Creator taps, turns, opens, pours, wipes, presses, or holds the product detail close.',
      'Back camera macro, handheld',
      `Macro UGC keyframe of ${product} texture, finish, label, material, or surface detail in creator hands, ${baseStyle}`,
      'Hands rotate the product slowly, tap or touch the detail, and pause while the phone focus settles.'
    ),
    shot(
      'Lifestyle proof',
      'lifestyle',
      'in-use',
      'creator',
      'phone propped up',
      '"This is exactly where I would use it."',
      `Creator places ${product} into the everyday context where it helps ${audience}.`,
      'Phone propped up, real room perspective',
      `UGC lifestyle proof keyframe of ${product} being used naturally by ${creator}, real everyday setting, ${baseStyle}`,
      'Creator uses or places the product naturally in the space, with small real handheld imperfections.'
    ),
    shot(
      'Tiny reaction',
      'reaction',
      'result',
      'creator',
      'selfie close-up',
      '"Okay, I was not expecting that."',
      'Creator gives a small honest reaction to the result.',
      'Front camera close-up',
      `Selfie UGC reaction insert keyframe of ${creator} reacting to ${product}, honest natural face and product still visible, ${baseStyle}`,
      'Creator glances at the product, then back to the lens, with a small genuine reaction.'
    ),
  ]

  if (data.goal === 'unboxing_asmr') return unboxingShots
  if (data.goal === 'try_on_grwm') return tryOnShots
  return genericShots
}

function buildExpandedShotTemplates(data, requestedCount) {
  const targetCount = getNormalizedShotCount(requestedCount)
  const baseShots = buildShotTemplates(data)
  if (targetCount <= baseShots.length) return selectShotTemplates(baseShots, targetCount)

  const firstShot = baseShots[0]
  const finalShot = baseShots[baseShots.length - 1]
  const middleShots = baseShots.slice(1, -1)
  const supplementalShots = buildSupplementalShotTemplates(data)
  const neededMiddleCount = Math.max(0, targetCount - 2)
  const expandedMiddle = []

  while (expandedMiddle.length < neededMiddleCount) {
    const source = expandedMiddle.length < middleShots.length
      ? middleShots[expandedMiddle.length]
      : supplementalShots[(expandedMiddle.length - middleShots.length) % supplementalShots.length]
    expandedMiddle.push({
      ...source,
      title: expandedMiddle.length < middleShots.length
        ? source.title
        : `${source.title} ${Math.floor((expandedMiddle.length - middleShots.length) / supplementalShots.length) + 1}`,
    })
  }

  return [firstShot, ...expandedMiddle, finalShot]
}

function buildDirectorScript(data, shotOverrides = {}) {
  const shotCount = getNormalizedShotCount(data.shotCount)
  const shotDuration = getShotDuration(shotCount, data.commercialLength)
  const shots = buildExpandedShotTemplates(data, shotCount).map((shot, index) => ({
    ...shot,
    ...(shotOverrides?.[index] || {}),
  }))
  return [
    `Scene 1: ${[compact(data.productService || data.product, ''), compact(data.goalLabel || data.formatLabel, 'UGC Ad')].filter(Boolean).join(' ')}`,
    `Scene context: Creator-style vertical UGC for ${compact(data.audience, 'the target viewer')}. Product: ${compact(data.productService || data.product, 'the product')}. Hook: ${compact(data.hook, 'Okay, I need to show you this.')}. Core reason to care: ${compact(data.offer || data.promise, 'the product benefit')}. Proof moment: ${compact(data.proof, 'believable product proof')}. CTA: ${compact(data.cta, 'soft call to action')}. Destination: ${compact(data.destination, 'website/contact')}. Setting: ${compact(data.location, 'natural creator environment')}. Visual rules: ${compact(data.visualRules || data.colors, 'phone-native UGC')}. Creator direction: ${data.noVisibleTalent ? 'hands-only, no face visible' : compact(data.talentDirection, 'creator talks naturally to camera')}. Tone: ${compact(data.toneText, 'casual friend energy')}. Pacing: keep the dialogue relaxed and unhurried — finish the final spoken line a beat before the clip ends, then hold a short natural beat (a smile or nod) so nothing gets cut off.`,
    data.environmentReferenceName
      ? `Environment reference: Treat ${data.environmentReferenceName} as the room/location anchor. Prefer this reference over generic setting words, and match its surfaces, lighting, colors, and background continuity when composing each shot.`
      : '',
    '',
    ...shots.map((shot, index) => [
      `Shot ${index + 1}: ${shot.title}`,
      `Ad beat: ${shot.adBeat}`,
      `Product mode: ${shot.productMode}`,
      `Talent mode: ${data.noVisibleTalent ? 'hands only / no face' : shot.talentMode || 'creator'}`,
      `Shot type: ${shot.shotType}`,
      `Creator dialogue: ${shot.dialogue}`,
      `Product action: ${shot.productAction}`,
      `Camera mode: ${shot.camera}`,
      `Keyframe prompt: ${shot.keyframe}`,
      `Motion prompt: ${shot.motion}`,
      index === shots.length - 1 ? `CTA note: ${compact(data.cta, 'soft product recommendation')}` : '',
      `Duration: ${shotDuration}`,
    ].filter(Boolean).join('\n')),
  ].join('\n\n')
}

function stripDialogueQuotes(value) {
  const text = String(value || '').trim()
  return text.replace(/^["“”]+|["“”]+$/g, '')
}

function formatDialogueForScript(value) {
  const text = stripDialogueQuotes(value)
  if (!text) return 'No spoken line, product moment only.'
  if (/^no spoken line/i.test(text) || /^silent/i.test(text)) return text
  return `"${text}"`
}

function shotHasNoDialogue(shot) {
  const text = String(shot?.dialogue || '').trim()
  return !stripDialogueQuotes(text) || /^(no spoken line|silent|no dialogue)/i.test(text)
}

function buildExternalLlmPrompt(data, currentScript) {
  return [
    'Write a Velorn Director Mode script for an editable UGC-style social ad using this exact structure.',
    '',
    'Return only the script. Do not include explanation, markdown, or notes.',
    '',
    `Product: ${compact(data.productService || data.product, 'Product')}`,
    `Hook: ${compact(data.hook, 'Okay, I need to show you this.')}`,
    `UGC format: ${compact(data.goalLabel || data.formatLabel, 'Casual review')}`,
    '',
    UGC_ARCHETYPE_SPECS[data.goal] || UGC_ARCHETYPE_SPECS.casual_review,
    'Follow this structure for THIS product specifically — translate each beat into actions that make sense for the actual product (do not copy beats that do not fit it).',
    '',
    `Viewer: ${compact(data.audience, 'target viewer')}`,
    `Reason to care: ${compact(data.offer || data.promise, 'product benefit')}`,
    `Proof / demo moment: ${compact(data.proof, 'believable proof')}`,
    `CTA: ${compact(data.cta, 'soft recommendation')}`,
    `Destination: ${compact(data.destination, 'website/contact')}`,
    `Setting: ${compact(data.location, 'natural creator environment')}`,
    `Visual rules: ${compact(data.visualRules || data.colors, 'phone-native UGC visuals')}`,
    data.environmentReferenceName
      ? `Environment reference: ${data.environmentReferenceName}. Treat it as the room/location anchor and match its surfaces, lighting, colors, and background continuity.`
      : 'Environment reference: none provided',
    `Aspect ratio: ${compact(data.aspectRatioLabel, data.platform || '9:16')}`,
    `Tone: ${compact(data.toneText, 'casual friend energy')}`,
    `Final ad length target: ${Number(data.commercialLength) || 15} seconds`,
    `Shot count: ${Number(data.shotCount) || 5}`,
    `Output resolution: ${data.resolutionLabel}`,
    `Frames per second: ${Number(data.videoFps) || FIXED_UGC_FPS} fps`,
    `Creator: ${data.noVisibleTalent ? 'Hands-only / no visible face' : compact(data.talentDirection, 'natural creator talking to camera')}`,
    '',
    'Required structure for every shot:',
    'Shot N: Short title',
    'Ad beat: hook | product reveal | demo | proof | reaction | testimonial | CTA',
    'Product mode: in-hand | packaging reveal | hero | macro detail | in-use | result | try-on | beauty display',
    'Talent mode: creator | creator hands | hands only | no face | lifestyle model',
    'Shot type: selfie close-up / front camera / back camera close-up / overhead top-down / phone propped up / medium demo shot',
    'Creator dialogue: the exact line the creator says, natural and short',
    'Product action: what the product does or how it is handled',
    'Camera mode: iPhone front camera, back camera, overhead, phone propped up, or handheld',
    'Keyframe prompt: one still image prompt, no rendered text',
    'Motion prompt: image-to-video motion from that exact keyframe',
    'Duration: 2 to 5 seconds',
    '',
    'Rules:',
    '- Use one block per shot.',
    '- Make it feel like a real creator made it on their phone, not a polished brand commercial.',
    '- Include human reaction, product handling, and creator dialogue in every shot unless the format is hands-only ASMR.',
    '- Keep product, creator, and environment identity consistent with references when references are available.',
    '- Do not ask Velorn to render captions or text into images.',
    '- Avoid split screens, collages, storyboard grids, watermarks, fake app UI, random letters, and fake typography.',
    '- Avoid medical, financial, or legal overclaims. Keep proof believable and conversational.',
    '',
    'Current editable script draft to improve or follow:',
    '',
    currentScript || buildDirectorScript(data),
  ].join('\n')
}

function flattenPlanShots(plan) {
  const rows = []
  for (const scene of plan || []) {
    for (const shot of scene?.shots || []) {
      rows.push({ scene, shot })
    }
  }
  return rows
}

// Pull the first shot's keyframe-prompt line out of the master script so the
// LTX first-frame compose matches the ad's actual opening shot instead of a
// fixed "creator holding the product" template.
function extractFirstKeyframePrompt(script = '') {
  const match = String(script || '').match(/keyframe\s*prompt\s*:\s*([^\n]+)/i)
  return match ? match[1].trim() : ''
}

export default function UGCAdCreator({
  assets,
  yoloUgcVoiceAssetMap,
  generationQueue,
  yoloActivePlan,
  yoloQueueVariants,
  yoloStoryboardAssetMap,
  yoloStoryboardReadyCount,
  yoloActivePlanIsStale,
  yoloDependencyCheckInProgress,
  yoloAdCustomKeyframeWorkflow,
  yoloAdCustomKeyframeValidation,
  yoloCustomKeyframeBridgeStatus,
  yoloCustomKeyframeBridgeBusy,
  yoloScript,
  setYoloScript,
  setYoloStyleNotes,
  setYoloAdBrandName,
  setYoloAdProductName,
  setYoloAdColorPalette,
  setYoloAdLogoConstraints,
  setYoloAdSpokespersonRole,
  setYoloAdWardrobeNotes,
  setYoloAdProductAssetId,
  setYoloAdModelAssetId,
  setYoloAdFormatPreset,
  setYoloAdPlatformPreset,
  setYoloAdStoryboardSource,
  setYoloAdStoryboardTier,
  setYoloAdVideoSource,
  setYoloAdVideoTier,
  setYoloAdLocalVideoWorkflowId,
  setYoloTargetDuration,
  setYoloShotsPerScene,
  setYoloAnglesPerShot,
  setYoloTakesPerAngle,
  setYoloVideoFps,
  setResolution,
  setImageResolution,
  handleBuildActiveYoloPlan,
  handleQueueYoloStoryboards,
  handleQueueYoloShotStoryboard,
  handleQueueYoloVideos,
  handleQueueYoloShotVideo,
  handleQueueUgcVoices,
  handleQueueUgcVoicePreviews,
  handleQueueUgcOneShot,
  voicePreviews,
  handleOpenYoloAdCustomKeyframeWorkflowInComfyUi,
  handleImportYoloAdCustomKeyframeWorkflow,
  handleClearYoloAdCustomKeyframeWorkflow,
  handleInstallYoloMusicCustomKeyframeBridge,
  handleCheckYoloMusicCustomKeyframeBridge,
  handleYoloShotImageBeatChange,
  handleYoloShotVideoBeatChange,
  handleYoloShotTakesChange,
  handleAssembleAdTimeline,
}) {
  const initialDraft = useMemo(() => loadUgcAdDraft(), [])
  const [step, setStep] = useState('setup')
  const [businessName, setBusinessName] = useState(initialDraft.businessName)
  const [productService, setProductService] = useState(initialDraft.productService)
  const [hook, setHook] = useState(initialDraft.hook)
  const [audience, setAudience] = useState(initialDraft.audience)
  const [offer, setOffer] = useState(initialDraft.offer)
  const [proof, setProof] = useState(initialDraft.proof)
  const [cta, setCta] = useState(initialDraft.cta)
  const [destination, setDestination] = useState(initialDraft.destination)
  const [location, setLocation] = useState(initialDraft.location)
  const [visualRules, setVisualRules] = useState(initialDraft.visualRules)
  const [talentDirection, setTalentDirection] = useState(initialDraft.talentDirection)
  const [goal, setGoal] = useState(initialDraft.goal)
  const [platform, setPlatform] = useState(initialDraft.platform)
  const [tone, setTone] = useState(initialDraft.tone)
  const [resolutionPreset, setResolutionPreset] = useState(initialDraft.resolutionPreset)
  const [videoFps, setVideoFps] = useState(initialDraft.videoFps)
  const [commercialLength, setCommercialLength] = useState(initialDraft.commercialLength)
  const [shotCount, setShotCount] = useState(initialDraft.shotCount)
  const [keyframeWorkflowId, setKeyframeWorkflowId] = useState(initialDraft.keyframeWorkflowId)
  const [videoWorkflowId, setVideoWorkflowId] = useState(initialDraft.videoWorkflowId)
  const [voiceMode, setVoiceMode] = useState(initialDraft.voiceMode)
  const [voiceId, setVoiceId] = useState(initialDraft.voiceId)
  const [voiceModel, setVoiceModel] = useState(initialDraft.voiceModel)
  const [voiceStability, setVoiceStability] = useState(initialDraft.voiceStability)
  const [voiceDelivery, setVoiceDelivery] = useState(initialDraft.voiceDelivery || {})
  const [voiceStatus, setVoiceStatus] = useState('')
  const [isQueuingVoices, setIsQueuingVoices] = useState(false)
  const [regeneratingVoiceKey, setRegeneratingVoiceKey] = useState('')
  const [isGeneratingPreviews, setIsGeneratingPreviews] = useState(false)
  const [isGeneratingOneShot, setIsGeneratingOneShot] = useState(false)
  const [oneShotStatus, setOneShotStatus] = useState('')
  const [productAssetId, setProductAssetId] = useState(initialDraft.productAssetId)
  const [talentAssetId, setTalentAssetId] = useState(initialDraft.talentAssetId)
  const [environmentAssetId, setEnvironmentAssetId] = useState(initialDraft.environmentAssetId)
  const [noVisibleTalent, setNoVisibleTalent] = useState(initialDraft.noVisibleTalent)
  const [directorScript, setDirectorScript] = useState(initialDraft.directorScript || yoloScript || '')
  const [scriptViewMode, setScriptViewMode] = useState('full')
  const [scriptShotOverrides, setScriptShotOverrides] = useState({})
  // True only when the user has hand-edited the raw director script. While false,
  // the live `generatedScript` (built from the brief + per-shot Creator lines) is
  // the source of truth for both display and generation, so the raw script can
  // never silently disagree with — or override — the live shots. Any structured
  // change (a Creator line, length, shot count, rebuild, re-entering this step)
  // snaps this back to false.
  const [scriptManuallyEdited, setScriptManuallyEdited] = useState(Boolean(initialDraft.scriptManuallyEdited))
  const [selectedShotIndex, setSelectedShotIndex] = useState(0)
  const [selectedVideoIndex, setSelectedVideoIndex] = useState(0)
  const [keyframeStatus, setKeyframeStatus] = useState('Ready to generate one keyframe.')
  const [videoStatus, setVideoStatus] = useState('Ready to generate one video.')
  const [timelineStatus, setTimelineStatus] = useState('')
  const [timelineStatusOk, setTimelineStatusOk] = useState(true)
  const [llmCopyStatus, setLlmCopyStatus] = useState('')
  const [isQueuingKeyframes, setIsQueuingKeyframes] = useState(false)
  const [isQueuingVideos, setIsQueuingVideos] = useState(false)
  const [isAssemblingTimeline, setIsAssemblingTimeline] = useState(false)
  const [socialPreviewClipIndex, setSocialPreviewClipIndex] = useState(0)
  const [socialPreviewEditEnabled, setSocialPreviewEditEnabled] = useState(false)

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    const draft = {
      businessName,
      productService,
      hook,
      audience,
      offer,
      proof,
      cta,
      destination,
      location,
      visualRules,
      talentDirection,
      goal,
      platform,
      tone,
      resolutionPreset,
      videoFps,
      commercialLength,
      shotCount,
      keyframeWorkflowId,
      videoWorkflowId,
      voiceMode,
      voiceId,
      voiceModel,
      voiceStability,
      voiceDelivery,
      productAssetId,
      talentAssetId,
      environmentAssetId,
      noVisibleTalent,
      directorScript,
      scriptManuallyEdited,
      updatedAt: new Date().toISOString(),
    }
    try {
      localStorage.setItem(UGC_AD_DRAFT_STORAGE_KEY, JSON.stringify(draft))
    } catch (_) {
      // Ignore storage failures so the form still works in private or restricted contexts.
    }
  }, [
    audience,
    businessName,
    commercialLength,
    cta,
    destination,
    directorScript,
    scriptManuallyEdited,
    environmentAssetId,
    goal,
    hook,
    keyframeWorkflowId,
    location,
    noVisibleTalent,
    offer,
    platform,
    productService,
    productAssetId,
    proof,
    resolutionPreset,
    shotCount,
    talentAssetId,
    talentDirection,
    tone,
    videoFps,
    videoWorkflowId,
    voiceMode,
    voiceId,
    voiceModel,
    voiceStability,
    voiceDelivery,
    visualRules,
  ])

  const imageAssets = useMemo(() => (assets || []).filter((asset) => asset?.type === 'image'), [assets])
  const environmentAsset = useMemo(
    () => imageAssets.find((asset) => asset?.id === environmentAssetId) || null,
    [environmentAssetId, imageAssets]
  )
  const videoAssetMap = useMemo(() => {
    const map = new Map()
    for (const asset of assets || []) {
      if (asset?.type !== 'video' || asset?.yolo?.stage !== 'video') continue
      if (asset?.yolo?.mode === 'music') continue
      const workflowScopedKey = getVideoVariantWorkflowKey(asset?.yolo?.variantKey, asset?.yolo?.workflowId)
      if (workflowScopedKey) map.set(workflowScopedKey, asset)
      if (asset?.yolo?.key) map.set(asset.yolo.key, asset)
      if (asset?.yolo?.variantKey && !asset?.yolo?.workflowId) map.set(asset.yolo.variantKey, asset)
    }
    return map
  }, [assets])
  // Cross-model fallback: most recent ready video per shot variant across all video
  // models. Used so the Assemble button enables (and cards show a clip) even when a
  // shot was generated with a different model than the one currently selected.
  const videoAssetByVariantKey = useMemo(() => {
    const map = new Map()
    for (const asset of assets || []) {
      if (asset?.type !== 'video' || asset?.yolo?.stage !== 'video') continue
      if (asset?.yolo?.mode === 'music') continue
      const variantKey = String(asset?.yolo?.variantKey || '').trim()
      if (!variantKey) continue
      const existing = map.get(variantKey)
      const assetTime = new Date(asset.createdAt || 0).getTime()
      const existingTime = existing ? new Date(existing.createdAt || 0).getTime() : -1
      if (!existing || assetTime >= existingTime) map.set(variantKey, asset)
    }
    return map
  }, [assets])
  const planShots = useMemo(() => flattenPlanShots(yoloActivePlan), [yoloActivePlan])
  const storyboardJobMap = useMemo(() => {
    const map = new Map()
    for (const job of generationQueue || []) {
      if (job?.yolo?.mode === 'music') continue
      if (job?.yolo?.stage !== 'storyboard' || !job?.yolo?.key) continue
      map.set(job.yolo.key, job)
    }
    return map
  }, [generationQueue])
  const videoJobMap = useMemo(() => {
    const map = new Map()
    for (const job of generationQueue || []) {
      if (job?.yolo?.mode === 'music') continue
      if (job?.yolo?.stage !== 'video') continue
      const workflowScopedKey = getVideoVariantWorkflowKey(job?.yolo?.variantKey, job?.yolo?.workflowId)
      if (workflowScopedKey) map.set(workflowScopedKey, job)
      if (job?.yolo?.key) map.set(job.yolo.key, job)
      if (job?.yolo?.variantKey && !job?.yolo?.workflowId) map.set(job.yolo.variantKey, job)
    }
    return map
  }, [generationQueue])

  const selectedTone = TONE_OPTIONS.find((option) => option.id === tone) || TONE_OPTIONS[0]
  const selectedGoal = UGC_FORMAT_OPTIONS.find((option) => option.id === goal) || UGC_FORMAT_OPTIONS[0]
  const selectedKeyframeWorkflow = KEYFRAME_MODEL_OPTIONS.find((option) => option.id === keyframeWorkflowId) || KEYFRAME_MODEL_OPTIONS[0]
  const selectedVideoWorkflow = VIDEO_MODEL_OPTIONS.find((option) => option.id === videoWorkflowId) || VIDEO_MODEL_OPTIONS[0]
  const selectedAspectRatio = ASPECT_RATIO_OPTIONS.find((option) => option.id === platform) || ASPECT_RATIO_OPTIONS[0]
  const mappedFormatPreset = goal === 'try_on_grwm'
    ? 'fashion_lifestyle'
    : goal === 'unboxing_asmr' || goal === 'demo_review' || goal === 'reaction_hook'
      ? 'product_demo'
      : 'ugc_testimonial'
  const customKeyframeWorkflowSelected = selectedKeyframeWorkflow.workflowId === CUSTOM_AD_KEYFRAME_WORKFLOW_ID
  const customKeyframeWorkflowLoaded = Boolean(String(yoloAdCustomKeyframeWorkflow?.jsonText || '').trim())
  const customKeyframeWorkflowName = String(yoloAdCustomKeyframeWorkflow?.name || '').trim()
  const customKeyframeValidation = yoloAdCustomKeyframeValidation || {
    ok: false,
    warnings: [],
    message: 'No custom UGC keyframe workflow loaded yet.',
  }
  const customKeyframeNeedsSetup = Boolean(customKeyframeWorkflowSelected && !customKeyframeValidation.ok)
  const openCustomKeyframeWorkflowLabel = customKeyframeWorkflowLoaded ? 'Open in ComfyUI' : 'Open Starter in ComfyUI'
  const bridgeState = String(yoloCustomKeyframeBridgeStatus?.state || '').trim()
  const bridgeInstalled = Boolean(yoloCustomKeyframeBridgeStatus?.installed)
  const bridgeMessage = String(yoloCustomKeyframeBridgeStatus?.message || yoloCustomKeyframeBridgeStatus?.error || '').trim()
  const bridgeBadge = bridgeInstalled
    ? { label: 'Installed', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' }
    : bridgeState === 'unavailable'
      ? { label: 'Unavailable', className: 'border-amber-500/40 bg-amber-500/10 text-amber-200' }
      : { label: 'Optional', className: 'border-sf-dark-600 bg-sf-dark-900 text-sf-text-muted' }
  const canInstallBridge = typeof handleInstallYoloMusicCustomKeyframeBridge === 'function'
  const canOpenCustomKeyframeWorkflow = typeof handleOpenYoloAdCustomKeyframeWorkflowInComfyUi === 'function' && (!customKeyframeWorkflowLoaded || customKeyframeValidation.ok)
  const keyframeReferenceMissing = Boolean(
    selectedKeyframeWorkflow.needsReference &&
    !productAssetId &&
    (noVisibleTalent || !talentAssetId) &&
    !environmentAssetId
  )
  const outputResolution = useMemo(
    () => resolveOutputResolution(platform, resolutionPreset),
    [platform, resolutionPreset]
  )
  const outputResolutionLabel = formatResolutionLabel(outputResolution)

  const currentData = {
    brand: businessName,
    product: productService,
    hook,
    colors: visualRules,
    audience,
    promise: offer,
    businessName,
    productService,
    offer,
    proof,
    cta,
    destination,
    location,
    visualRules,
    talentDirection,
    format: mappedFormatPreset,
    goal,
    goalLabel: selectedGoal.label,
    formatLabel: selectedGoal.label,
    platform,
    aspectRatioLabel: selectedAspectRatio.label,
    tone,
    toneText: selectedTone.text,
    resolutionPreset,
    resolutionLabel: outputResolutionLabel,
    videoFps,
    commercialLength,
    // Beats scale with the chosen length so the last line isn't clipped (the
    // generated/LLM script is always duration-appropriate, regardless of any
    // stale shotCount).
    shotCount: getSuggestedShotCount(commercialLength),
    noVisibleTalent,
    environmentReferenceName: environmentAsset?.name || '',
  }

  const generatedScript = useMemo(() => buildDirectorScript(currentData, scriptShotOverrides), [
    audience,
    businessName,
    commercialLength,
    cta,
    destination,
    environmentAsset?.name,
    goal,
    hook,
    location,
    noVisibleTalent,
    offer,
    outputResolutionLabel,
    platform,
    productService,
    proof,
    resolutionPreset,
    selectedGoal.label,
    shotCount,
    scriptShotOverrides,
    talentDirection,
    tone,
    videoFps,
    visualRules,
  ])
  const scriptReviewShots = useMemo(
    () => buildExpandedShotTemplates(currentData, shotCount).map((shot, index) => ({
      ...shot,
      ...(scriptShotOverrides?.[index] || {}),
    })),
    [
      audience,
      businessName,
      commercialLength,
      environmentAsset?.name,
      goal,
      hook,
      location,
      noVisibleTalent,
      offer,
      productService,
      proof,
      scriptShotOverrides,
      shotCount,
      talentDirection,
      visualRules,
    ]
  )
  const externalLlmPrompt = useMemo(
    () => buildExternalLlmPrompt(currentData, scriptManuallyEdited ? directorScript : generatedScript),
    [currentData, directorScript, generatedScript, scriptManuallyEdited]
  )

  const buildEasyModeStyleNotes = () => ([
    selectedGoal.label,
    selectedTone.text,
    visualRules,
    `Brand: ${businessName}`,
    `Offer: ${offer}`,
    `CTA: ${cta}`,
    destination ? `Destination: ${destination}` : '',
    location ? `Room/location: ${location}` : '',
    proof ? `Proof/demo moment: ${proof}` : '',
    `Aspect ratio: ${selectedAspectRatio.label}`,
    `Output resolution: ${outputResolutionLabel}`,
    `FPS: ${Number(videoFps) || FIXED_UGC_FPS}`,
    productAssetId ? 'Use the product reference as the packaging/product anchor.' : '',
    talentAssetId && !noVisibleTalent ? 'Use the creator reference as the identity/wardrobe/personality anchor.' : '',
    environmentAsset ? `Use the environment reference (${environmentAsset.name}) as the location anchor. Prefer its room, surfaces, lighting, colors, and background style over generic setting words.` : '',
  ].filter(Boolean).join('. '))

  const getKeyframeReferenceOverrides = () => {
    const isNanoKeyframe = selectedKeyframeWorkflow.workflowId === 'nano-banana-2'
    const ids = []
    const addId = (assetId) => {
      const value = String(assetId || '').trim()
      if (value && !ids.includes(value)) ids.push(value)
    }

    if (isNanoKeyframe) {
      // Nano receives a plain reference-image batch, not named creator/product
      // fields. Put creator first so identity/wardrobe gets the strongest
      // anchor, then product second. Environment is a fallback when one slot is
      // open because Nano only supports two refs in this path.
      if (!noVisibleTalent) addId(talentAssetId)
      addId(productAssetId)
      addId(environmentAssetId)
      return {
        productAssetIdOverride: ids[0] || '',
        modelAssetIdOverride: ids[1] || '',
      }
    }

    addId(productAssetId)
    if (!noVisibleTalent) addId(talentAssetId)
    if (ids.length === 0) addId(environmentAssetId)

    return {
      productAssetIdOverride: ids[0] || '',
      modelAssetIdOverride: ids[1] || '',
    }
  }

  const getKeyframeReferenceAssetIds = () => {
    if (selectedKeyframeWorkflow.workflowId !== GPT_IMAGE_2_UGC_KEYFRAME_WORKFLOW_ID) return []
    const ids = []
    const addId = (assetId) => {
      const value = String(assetId || '').trim()
      if (value && !ids.includes(value)) ids.push(value)
    }

    addId(talentAssetId)
    addId(productAssetId)
    addId(environmentAssetId)

    return ids
  }

  const getVideoReferenceAssetIds = () => {
    const ids = []
    const addId = (assetId) => {
      const value = String(assetId || '').trim()
      if (value && !ids.includes(value)) ids.push(value)
    }

    addId(productAssetId)
    if (!noVisibleTalent) addId(talentAssetId)
    addId(environmentAssetId)

    return ids
  }

  const applyToDirector = (scriptOverride = scriptManuallyEdited ? directorScript : generatedScript) => {
    const script = scriptOverride || generatedScript
    setYoloAdBrandName(businessName)
    setYoloAdProductName(productService)
    setYoloAdColorPalette(visualRules)
    setYoloAdLogoConstraints([offer, cta, destination, proof].filter(Boolean).join(' | '))
    setYoloAdSpokespersonRole(noVisibleTalent ? 'Hands-only / no face' : talentDirection)
    setYoloAdWardrobeNotes(noVisibleTalent ? '' : talentDirection)
    setYoloAdProductAssetId(productAssetId || null)
    setYoloAdModelAssetId(noVisibleTalent ? null : (talentAssetId || null))
    setYoloAdFormatPreset(mappedFormatPreset)
    setYoloAdPlatformPreset(platform)
    setYoloAdStoryboardSource(selectedKeyframeWorkflow.source)
    setYoloAdStoryboardTier(selectedKeyframeWorkflow.tier)
    setYoloAdVideoSource('local')
    setYoloAdVideoTier('quality')
    setYoloAdLocalVideoWorkflowId(videoWorkflowId)
    setYoloTargetDuration(Number(commercialLength) || 15)
    setYoloShotsPerScene(Number(shotCount) || 5)
    setYoloAnglesPerShot(1)
    setYoloTakesPerAngle(1)
    setYoloVideoFps(Number(videoFps) || FIXED_UGC_FPS)
    setResolution(outputResolution)
    setImageResolution(outputResolution)
    setYoloStyleNotes(buildEasyModeStyleNotes())
    setYoloScript(script)
  }

  const handleKeyframeWorkflowChange = (workflowId) => {
    const option = KEYFRAME_MODEL_OPTIONS.find((item) => item.id === workflowId) || KEYFRAME_MODEL_OPTIONS[0]
    setKeyframeWorkflowId(option.id)
    setYoloAdStoryboardSource(option.source)
    setYoloAdStoryboardTier(option.tier)
  }

  const handleVideoWorkflowChange = (workflowId) => {
    setVideoWorkflowId(workflowId)
    setYoloAdVideoSource('local')
    setYoloAdVideoTier('quality')
    setYoloAdLocalVideoWorkflowId(workflowId)
  }

  const goTo = (nextStep) => {
    // Seed the prompt from the freshly-built script ONLY when the user hasn't
    // hand-edited it. Once they've edited, keep their text so navigating away
    // and back (or returning via "Build Prompt") never wipes the prompt box.
    if ((nextStep === 'script' || nextStep === 'generate') && !scriptManuallyEdited) {
      setDirectorScript(generatedScript)
      applyToDirector(generatedScript)
    }
    setStep(nextStep)
  }

  const copyExternalLlmPrompt = async () => {
    setLlmCopyStatus('')
    try {
      await navigator.clipboard.writeText(externalLlmPrompt)
      setLlmCopyStatus('Copied prompt')
    } catch (_) {
      setLlmCopyStatus('Select and copy manually')
    }
  }

  const buildPlanOptions = (script, styleNotes) => ({
    scriptOverride: script,
    styleNotesOverride: styleNotes,
    targetDurationOverride: Number(commercialLength) || 15,
    shotsPerSceneOverride: Number(shotCount) || 5,
    anglesPerShotOverride: 1,
    takesPerAngleOverride: 1,
    ...getKeyframeReferenceOverrides(),
    productNameOverride: productService,
    brandNameOverride: businessName,
    colorPaletteOverride: visualRules,
    logoConstraintsOverride: [offer, cta, destination, proof].filter(Boolean).join(' | '),
    spokespersonRoleOverride: noVisibleTalent ? 'Hands-only / no face' : talentDirection,
    wardrobeNotesOverride: noVisibleTalent ? '' : talentDirection,
    formatPresetOverride: mappedFormatPreset,
    platformPresetOverride: platform,
  })

  const handleBuildPlan = () => {
    const script = scriptManuallyEdited ? directorScript : generatedScript
    const styleNotes = buildEasyModeStyleNotes()
    applyToDirector(script)
    const plan = handleBuildActiveYoloPlan(buildPlanOptions(script, styleNotes))
    if (Array.isArray(plan) && plan.length > 0) {
      setSelectedShotIndex(0)
      setSelectedVideoIndex(0)
      setKeyframeStatus('Plan ready. Choose a keyframe model, then create keyframes.')
      setVideoStatus('Plan ready. Generate keyframes before creating videos.')
      setStep('keyframes')
    } else {
      setKeyframeStatus('Could not build the plan. Check the script format and try again.')
    }
  }

  const handleRegenerateAllKeyframes = async () => {
    if (planShots.length === 0) return
    setIsQueuingKeyframes(true)
    setKeyframeStatus('Queueing regeneration for all keyframes...')
    try {
      const queuedCount = await handleQueueYoloStoryboards({
        planOverride: yoloActivePlan,
        skipStaleCheck: true,
        skipConfirm: true,
        allowExistingDoneKeys: true,
        sourceLabel: `UGC Creator ${selectedKeyframeWorkflow.label} keyframe regeneration pass`,
        ...getKeyframeReferenceOverrides(),
        storyboardReferenceAssetIdsOverride: getKeyframeReferenceAssetIds(),
        resolutionOverride: outputResolution,
        storyboardWorkflowIdOverride: selectedKeyframeWorkflow.workflowId,
      })
      setKeyframeStatus(
        queuedCount > 0
          ? `Queued ${queuedCount} keyframe regeneration job${queuedCount === 1 ? '' : 's'}.`
          : 'No keyframe regeneration jobs were queued. Check whether those shots are already running.'
      )
    } finally {
      setIsQueuingKeyframes(false)
    }
  }

  const handleRegenerateAllVideos = async () => {
    if (planShots.length === 0) return
    setIsQueuingVideos(true)
    setVideoStatus(`Queueing ${selectedVideoWorkflow.label} for all shot videos...`)
    setStep('videos')
    try {
      const queuedCount = await handleQueueYoloVideos({
        planOverride: yoloActivePlan,
        skipStaleCheck: true,
        skipConfirm: true,
        allowExistingDoneKeys: true,
        targetWorkflowIds: [videoWorkflowId],
        sourceLabel: `UGC Creator ${selectedVideoWorkflow.label} video regeneration pass`,
        resolutionOverride: outputResolution,
        videoReferenceAssetIds: getVideoReferenceAssetIds(),
      })
      setVideoStatus(
        queuedCount > 0
          ? `Queued ${queuedCount} ${selectedVideoWorkflow.label} video job${queuedCount === 1 ? '' : 's'}.`
          : 'No video jobs were queued. Check for running shots or missing keyframes.'
      )
    } finally {
      setIsQueuingVideos(false)
    }
  }

  const updateLength = (value) => {
    const nextLength = normalizeDraftRangeNumber(value, DEFAULT_UGC_AD_DRAFT.commercialLength, MIN_UGC_LENGTH_SECONDS, MAX_UGC_LENGTH_SECONDS)
    const nextCount = getSuggestedShotCount(nextLength)
    setCommercialLength(nextLength)
    setShotCount(nextCount)
    const nextScript = buildDirectorScript({ ...currentData, commercialLength: nextLength, shotCount: nextCount }, scriptShotOverrides)
    setScriptManuallyEdited(false)
    setDirectorScript(nextScript)
    applyToDirector(nextScript)
    setYoloTargetDuration(nextLength)
    setYoloShotsPerScene(nextCount)
  }

  const updateShotCount = (value) => {
    const nextCount = Number(value) || 8
    setShotCount(nextCount)
    const nextScript = buildDirectorScript({ ...currentData, shotCount: nextCount }, scriptShotOverrides)
    setScriptManuallyEdited(false)
    setDirectorScript(nextScript)
    applyToDirector(nextScript)
    setYoloShotsPerScene(nextCount)
  }

  const updateScriptShotOverride = (index, field, value) => {
    setScriptShotOverrides((previous) => {
      const next = {
        ...previous,
        [index]: {
          ...(previous?.[index] || {}),
          [field]: field === 'dialogue' ? formatDialogueForScript(value) : value,
        },
      }
      const nextScript = buildDirectorScript(currentData, next)
      setScriptManuallyEdited(false)
      setDirectorScript(nextScript)
      setYoloScript(nextScript)
      return next
    })
  }

  const toggleScriptShotNoLine = (index, checked) => {
    const baseShot = buildExpandedShotTemplates(currentData, shotCount)[index]
    updateScriptShotOverride(
      index,
      'dialogue',
      checked ? 'No spoken line, product moment only.' : stripDialogueQuotes(baseShot?.dialogue || '')
    )
  }

  const selectedShotRow = planShots[selectedShotIndex] || planShots[0] || null
  const selectedVideoRow = planShots[selectedVideoIndex] || planShots[0] || null

  const getFirstVariantForShot = (sceneId, shotId) => (
    (yoloQueueVariants || []).find((variant) => variant.sceneId === sceneId && variant.shotId === shotId) || null
  )

  const getVideoAssetForVariant = (variant, workflowId = videoWorkflowId) => {
    if (!variant?.key) return null
    const workflowScopedKey = getVideoVariantWorkflowKey(variant.key, workflowId)
    return (workflowScopedKey ? videoAssetMap.get(workflowScopedKey) : null)
      || videoAssetMap.get(variant.key)
      || videoAssetByVariantKey.get(variant.key)
      || null
  }

  const getVideoJobForVariant = (variant, workflowId = videoWorkflowId) => {
    if (!variant?.key) return null
    const workflowScopedKey = getVideoVariantWorkflowKey(variant.key, workflowId)
    return (workflowScopedKey ? videoJobMap.get(workflowScopedKey) : null) || videoJobMap.get(variant.key) || null
  }

  const getKeyframeCardState = (variant, asset) => {
    if (asset) return { state: 'ready', label: 'Keyframe ready', job: null }
    const job = variant ? storyboardJobMap.get(variant.key) : null
    if (job?.status === 'error') return { state: 'error', label: 'Keyframe failed', job }
    if (job && KEYFRAME_BUSY_STATUSES.has(job.status)) {
      const label = job.status === 'queued'
        ? 'Queued'
        : job.status === 'saving'
          ? 'Saving keyframe'
          : 'Generating keyframe'
      return { state: 'generating', label, job }
    }
    return { state: 'pending', label: 'Keyframe pending', job }
  }

  const getVideoCardState = (variant, asset, hasKeyframe) => {
    if (asset) return { state: 'ready', label: 'Video ready', job: null }
    const job = getVideoJobForVariant(variant)
    if (job?.status === 'error') return { state: 'error', label: 'Video failed', job }
    if (job && VIDEO_BUSY_STATUSES.has(job.status)) {
      const label = job.status === 'queued'
        ? 'Queued'
        : job.status === 'saving'
          ? 'Saving video'
          : 'Generating video'
      return { state: 'generating', label, job }
    }
    if (!hasKeyframe) return { state: 'blocked', label: 'Needs keyframe', job: null }
    return { state: 'pending', label: 'Ready to queue', job }
  }

  const keyframeGeneratingCount = planShots.reduce((count, { scene, shot }) => {
    const variant = getFirstVariantForShot(scene.id, shot.id)
    const asset = variant ? yoloStoryboardAssetMap?.get(variant.key) : null
    const cardState = getKeyframeCardState(variant, asset)
    return count + (cardState.state === 'generating' ? 1 : 0)
  }, 0)
  const videoGeneratingCount = planShots.reduce((count, { scene, shot }) => {
    const variant = getFirstVariantForShot(scene.id, shot.id)
    const asset = getVideoAssetForVariant(variant)
    const hasKeyframe = variant ? yoloStoryboardAssetMap?.has(variant.key) : false
    const cardState = getVideoCardState(variant, asset, hasKeyframe)
    return count + (cardState.state === 'generating' ? 1 : 0)
  }, 0)
  const videoReadyCount = planShots.reduce((count, { scene, shot }) => {
    const variant = getFirstVariantForShot(scene.id, shot.id)
    const asset = getVideoAssetForVariant(variant)
    return count + (asset ? 1 : 0)
  }, 0)
  const socialPreviewClips = useMemo(() => planShots.map(({ scene, shot }, index) => {
    const variant = (yoloQueueVariants || []).find((item) => item.sceneId === scene.id && item.shotId === shot.id)
    const workflowScopedKey = getVideoVariantWorkflowKey(variant?.key, videoWorkflowId)
    const asset = variant?.key
      ? (workflowScopedKey ? videoAssetMap.get(workflowScopedKey) : null) || videoAssetMap.get(variant.key) || null
      : null
    const url = getAssetUrl(asset)
    if (!url) return null
    return {
      key: `${variant?.key || `${scene.id}-${shot.id}`}::${asset?.id || url}`,
      url,
      index,
      shotId: shot.id,
      caption: compact(shot.videoBeat || shot.beat || shot.title, 'ready clip'),
    }
  }).filter(Boolean), [planShots, videoAssetMap, videoWorkflowId, yoloQueueVariants])
  const socialPreviewClipSignature = socialPreviewClips.map((clip) => clip.key).join('|')

  useEffect(() => {
    setSocialPreviewClipIndex(0)
    if (socialPreviewClips.length === 0) {
      setSocialPreviewEditEnabled(false)
    }
  }, [socialPreviewClipSignature, socialPreviewClips.length])

  const handleAssembleTimeline = async () => {
    if (!handleAssembleAdTimeline) return
    setIsAssemblingTimeline(true)
    setTimelineStatus('')
    setTimelineStatusOk(true)
    try {
      const result = await handleAssembleAdTimeline({
        workflowId: videoWorkflowId,
        workflowLabel: selectedVideoWorkflow.label,
        resolution: outputResolution,
        includeLinkedVideoAudio: true,
        linkedVideoAudioTrackName: 'UGC - Clip Audio',
      })
      setTimelineStatus(result?.message || 'Timeline assembled.')
      setTimelineStatusOk(result?.ok !== false)
    } catch (error) {
      setTimelineStatus(`Could not assemble timeline: ${error?.message || 'Unknown error'}`)
      setTimelineStatusOk(false)
    } finally {
      setIsAssemblingTimeline(false)
    }
  }

  // Voiceover: count spoken vs silent shots and how many already have a clip.
  const voiceLineShots = useMemo(
    () => planShots.filter(({ shot }) => !shotHasNoDialogue(shot)),
    [planShots]
  )
  const voiceReadyCount = useMemo(() => voiceLineShots.reduce((count, { scene, shot }) => {
    const variant = getFirstVariantForShot(scene.id, shot.id)
    return variant && yoloUgcVoiceAssetMap?.has(variant.key) ? count + 1 : count
  }, 0), [voiceLineShots, yoloUgcVoiceAssetMap, yoloQueueVariants])

  // Per-shot final spoken text, keyed by variant.key. On v3 we prepend the
  // delivery note as an emotion tag (e.g. "[excited] line"); on v2 tags are
  // ignored so we send the bare line and rely on the stability slider.
  const buildVoiceLineOverrides = () => {
    const overrides = {}
    for (const { scene, shot } of voiceLineShots) {
      const variant = getFirstVariantForShot(scene.id, shot.id)
      if (!variant?.key) continue
      const baseLine = stripDialogueQuotes(shot.dialogue || '').trim()
      if (!baseLine) continue
      const delivery = String(voiceDelivery[shot.id] || '').trim()
      overrides[variant.key] = (voiceModel === 'eleven_v3' && delivery)
        ? `[${delivery}] ${baseLine}`
        : baseLine
    }
    return overrides
  }

  const voiceQueueOptions = () => ({
    voice: voiceId,
    model: voiceModel,
    stability: voiceStability,
    planOverride: yoloActivePlan,
    lineOverrides: buildVoiceLineOverrides(),
  })

  const handleGenerateAllVoices = async () => {
    if (!handleQueueUgcVoices || planShots.length === 0) return
    setIsQueuingVoices(true)
    setVoiceStatus(`Generating ${voiceLineShots.length} voice line${voiceLineShots.length === 1 ? '' : 's'} with ${voiceId}...`)
    try {
      const result = await handleQueueUgcVoices(voiceQueueOptions())
      const queued = result?.queued || 0
      setVoiceStatus(
        queued > 0
          ? `Queued ${queued} voice line${queued === 1 ? '' : 's'}. They appear below as they finish.`
          : (result?.skipped > 0 ? 'Those voice lines are already generating.' : 'No voice lines were queued.')
      )
    } catch (error) {
      setVoiceStatus(`Could not generate voices: ${error?.message || 'Unknown error'}`)
    } finally {
      setIsQueuingVoices(false)
    }
  }

  const previewCache = voicePreviews && typeof voicePreviews === 'object' ? voicePreviews : {}
  const cachedPreviewCount = VOICE_OPTIONS.filter((option) => previewCache[option]).length

  const handleGenerateVoicePreviews = async () => {
    if (!handleQueueUgcVoicePreviews) return
    const missing = VOICE_OPTIONS.filter((option) => !previewCache[option])
    if (missing.length === 0) {
      setVoiceStatus('All voice previews are already cached.')
      return
    }
    setIsGeneratingPreviews(true)
    setVoiceStatus(`Generating ${missing.length} voice preview${missing.length === 1 ? '' : 's'} (one-time, cached for every project)...`)
    try {
      const result = await handleQueueUgcVoicePreviews(missing)
      setVoiceStatus(
        result?.queued > 0
          ? `Queued ${result.queued} preview${result.queued === 1 ? '' : 's'}. They become playable below as they finish.`
          : 'No previews were queued.'
      )
    } catch (error) {
      setVoiceStatus(`Could not generate previews: ${error?.message || 'Unknown error'}`)
    } finally {
      setIsGeneratingPreviews(false)
    }
  }

  const handleRegenerateVoiceLine = async (scene, shot) => {
    const variant = getFirstVariantForShot(scene.id, shot.id)
    if (!handleQueueUgcVoices || !variant?.key) return
    setRegeneratingVoiceKey(variant.key)
    setVoiceStatus('Regenerating that line as a new take...')
    try {
      await handleQueueUgcVoices({
        ...voiceQueueOptions(),
        onlyVariantKeys: [variant.key],
        force: true,
      })
      setVoiceStatus('Queued a new take. It replaces the old clip when it finishes.')
    } catch (error) {
      setVoiceStatus(`Could not regenerate: ${error?.message || 'Unknown error'}`)
    } finally {
      setRegeneratingVoiceKey('')
    }
  }

  // One-shot generate: the editable master prompt is the director script; the
  // 3 references anchor identity; Seedance produces the whole ad + native audio.
  const oneShotPrompt = scriptManuallyEdited ? directorScript : generatedScript
  const oneShotDuration = Math.min(15, Math.max(5, Number(commercialLength) || 10))
  // Order matters for the LTX first-frame composer (creator, product, environment).
  const oneShotReferenceIds = [noVisibleTalent ? '' : talentAssetId, productAssetId, environmentAssetId].filter(Boolean)
  // First-frame compose prompt (LTX path only): prefer the master script's
  // opening-shot keyframe prompt so the frame matches the ad's actual first beat
  // and changes with edits; fall back to a generic brief-derived line only if
  // the script has no keyframe prompt.
  const oneShotFramePrompt = extractFirstKeyframePrompt(oneShotPrompt) || [
    talentDirection || 'young creator talking to camera',
    productService ? `holding ${productService}` : (businessName ? `holding ${businessName}` : ''),
    location ? `in ${location}` : 'in a natural home setting',
    'vertical 9:16 UGC selfie, photoreal, handheld phone look, natural light',
  ].filter(Boolean).join(', ')
  const oneShotAsset = useMemo(() => {
    const list = (assets || []).filter((a) => a?.type === 'video' && (a?.yolo?.stage === 'oneshot' || a?.settings?.yolo?.stage === 'oneshot'))
    list.sort((a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime())
    return list[0] || null
  }, [assets])
  const oneShotAssetUrl = getAssetUrl(oneShotAsset)

  const handleGenerateOneShot = async (model = 'seedance') => {
    if (!handleQueueUgcOneShot) return
    const promptText = String(oneShotPrompt || '').trim()
    if (!promptText) {
      setOneShotStatus('Write or build the prompt first.')
      return
    }
    const modelLabel = model === 'ltx' ? 'LTX 2.3 (local)' : 'Seedance 2.0'
    setIsGeneratingOneShot(true)
    setOneShotStatus(`Generating the full ad with ${modelLabel} (${oneShotDuration}s)…`)
    try {
      const res = await handleQueueUgcOneShot({
        model,
        prompt: promptText,
        framePrompt: oneShotFramePrompt,
        duration: oneShotDuration,
        width: outputResolution.width,
        height: outputResolution.height,
        referenceAssetIds: oneShotReferenceIds,
      })
      setOneShotStatus(res?.queued
        ? (res?.chained
          ? 'Composing a first frame from your references, then LTX 2.3 will animate it. Your ad appears below when done.'
          : `Queued (${modelLabel}). Your ad appears below when it finishes (also saved to your project assets).`)
        : 'Nothing was queued.')
    } catch (error) {
      setOneShotStatus(`Could not generate: ${error?.message || 'Unknown error'}`)
    } finally {
      setIsGeneratingOneShot(false)
    }
  }

  const stepIndex = STEPS.findIndex((item) => item.id === step)

  const renderStepNav = () => (
    <nav className="ugc-steps" aria-label="UGC ad steps">
      {STEPS.map((item, index) => (
        <button
          key={item.id}
          type="button"
          onClick={() => setStep(item.id)}
          disabled={(item.id === 'voiceover' || item.id === 'keyframes' || item.id === 'videos') && planShots.length === 0}
          className={`ugc-step-btn ${item.id === step ? 'active' : index < stepIndex ? 'done' : ''} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          <span className="ugc-step-kicker">Step {index + 1}</span>
          <span className="ugc-step-title">{item.label}</span>
        </button>
      ))}
    </nav>
  )

  const renderChoiceButton = (isSelected, label, onClick, helper = '', key = label) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      title={helper}
      className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
        isSelected
          ? 'border-[#ff4b2e] bg-[#ff4b2e]/10 text-[#ffb4a3]'
          : 'border-[#2e2c26] bg-[#161512] text-[#c9c6ba] hover:border-[#4a473e] hover:text-[#f1efe8]'
      }`}
    >
      <div className="font-medium">{label}</div>
      {helper ? <div className="mt-1 text-[10px] text-[#95927f]">{helper}</div> : null}
    </button>
  )

  const renderFormatButton = (option) => {
    const isSelected = goal === option.id
    return (
      <button
        key={`ugc-format-${option.id}`}
        type="button"
        onClick={() => setGoal(option.id)}
        className={`ugc-format-card ${isSelected ? 'selected' : ''}`}
      >
        <span className="ugc-format-emoji" aria-hidden="true">{option.emoji}</span>
        <span className="ugc-format-name">{option.label}</span>
        <span className="ugc-format-desc">{option.helper}</span>
      </button>
    )
  }

  const renderCustomKeyframeWorkflowPanel = () => {
    if (!customKeyframeWorkflowSelected) return null
    return (
      <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-sf-text-muted">Custom workflow contract</span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${
                customKeyframeValidation.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
              }`}>
                {customKeyframeValidation.ok ? 'Ready' : 'Needs setup'}
              </span>
            </div>
            <div className="mt-1 text-xs text-sf-text-primary">
              {customKeyframeWorkflowName || 'No custom workflow loaded'}
            </div>
            <p className="mt-1 text-[10px] leading-4 text-sf-text-muted">
              Required: <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_PROMPT</span> and <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_OUTPUT_IMAGE</span>. Optional: <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_INPUT_IMAGE</span>, <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_SEED</span>, <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_WIDTH</span>, <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_HEIGHT</span>.
            </p>
            <div className={`mt-2 text-[10px] ${customKeyframeValidation.ok ? 'text-emerald-300' : 'text-amber-200'}`}>
              {customKeyframeValidation.message}
            </div>
            {Array.isArray(customKeyframeValidation.warnings) && customKeyframeValidation.warnings.length > 0 && (
              <div className="mt-1 text-[10px] text-amber-200">
                {customKeyframeValidation.warnings.slice(0, 2).join(' ')}
              </div>
            )}
          </div>
          <div className="grid w-full shrink-0 gap-2 sm:w-auto sm:min-w-[180px]">
            <button
              type="button"
              onClick={handleOpenYoloAdCustomKeyframeWorkflowInComfyUi}
              disabled={!canOpenCustomKeyframeWorkflow}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-accent/50 bg-sf-accent/10 px-2 py-1.5 text-[10px] font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:border-sf-dark-600 disabled:bg-sf-dark-800 disabled:text-sf-text-muted"
              title={customKeyframeWorkflowLoaded ? 'Open the loaded custom workflow in the embedded ComfyUI tab.' : 'Load the starter workflow and open it in the embedded ComfyUI tab.'}
            >
              <ExternalLink className="h-3 w-3" />
              {openCustomKeyframeWorkflowLabel}
            </button>
            <button
              type="button"
              onClick={handleImportYoloAdCustomKeyframeWorkflow}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
              title="Import the API JSON you exported from ComfyUI."
            >
              <Clipboard className="h-3 w-3" />
              Import JSON
            </button>
            <button
              type="button"
              onClick={handleClearYoloAdCustomKeyframeWorkflow}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-muted transition-colors hover:border-red-500/60 hover:text-red-300"
              title="Clear the loaded custom workflow."
            >
              <X className="h-3 w-3" />
              Clear Custom
            </button>
          </div>
        </div>
        <div className="mt-3 border-t border-sf-dark-700 pt-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-sf-text-muted">Velorn bridge</span>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] ${bridgeBadge.className}`}>
                  {bridgeBadge.label}
                </span>
              </div>
              <p className="mt-1 text-[10px] leading-4 text-sf-text-muted">
                Adds a Send to Velorn button inside ComfyUI. Import JSON stays available as the fallback.
              </p>
              {bridgeMessage && (
                <div className={`mt-2 text-[10px] ${bridgeInstalled ? 'text-emerald-300' : bridgeState === 'unavailable' ? 'text-amber-200' : 'text-sf-text-secondary'}`}>
                  {bridgeMessage}
                </div>
              )}
            </div>
            <div className="grid w-full shrink-0 gap-2 sm:w-auto sm:min-w-[160px]">
              <button
                type="button"
                onClick={handleInstallYoloMusicCustomKeyframeBridge}
                disabled={!canInstallBridge || yoloCustomKeyframeBridgeBusy}
                className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-accent/50 bg-sf-accent/10 px-2 py-1.5 text-[10px] font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:border-sf-dark-600 disabled:bg-sf-dark-800 disabled:text-sf-text-muted"
                title={bridgeState === 'unavailable' ? 'Choose a ComfyUI folder or configure the launcher first.' : 'Install the bundled Velorn Bridge into ComfyUI custom_nodes.'}
              >
                {yoloCustomKeyframeBridgeBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                {bridgeInstalled ? 'Installed' : 'Install Bridge'}
              </button>
              <button
                type="button"
                onClick={() => handleCheckYoloMusicCustomKeyframeBridge?.({ silent: false })}
                disabled={yoloCustomKeyframeBridgeBusy || typeof handleCheckYoloMusicCustomKeyframeBridge !== 'function'}
                className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                title="Re-check whether the bridge is installed."
              >
                <RefreshCw className={`h-3 w-3 ${yoloCustomKeyframeBridgeBusy ? 'animate-spin' : ''}`} />
                Re-check
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderSideRail = () => {
    const previewHook = compact(hook, 'Okay, I need to show you this...')
    const activePreviewClip = socialPreviewEditEnabled && socialPreviewClips.length > 0
      ? socialPreviewClips[Math.min(socialPreviewClipIndex, socialPreviewClips.length - 1)]
      : null
    const brandHandle = compact(businessName, 'yourbrand')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 24) || 'yourbrand'

    return (
      <aside className="ugc-side">
        <div className="ugc-side-card">
          <div className="ugc-side-heading">
            <div className="ugc-side-title">Social preview</div>
            <button
              type="button"
              className={`ugc-preview-toggle ${socialPreviewEditEnabled ? 'active' : ''}`}
              disabled={socialPreviewClips.length === 0}
              onClick={() => {
                setSocialPreviewClipIndex(0)
                setSocialPreviewEditEnabled((enabled) => !enabled)
              }}
              title={socialPreviewClips.length === 0 ? 'Generate at least one video first.' : 'Preview the ready clips back-to-back in this phone.'}
            >
              {socialPreviewEditEnabled ? 'Stop' : 'Preview Edit'}
            </button>
          </div>
          <div className={`preview-phone ${(oneShotAssetUrl || activePreviewClip) ? 'has-video' : ''}`}>
            <span className="notch" />
            {oneShotAssetUrl ? (
              <video
                key={oneShotAssetUrl}
                src={oneShotAssetUrl}
                className="pv-video"
                controls
                playsInline
                preload="metadata"
              />
            ) : activePreviewClip ? (
              <>
                <video
                  key={activePreviewClip.key}
                  src={activePreviewClip.url}
                  className="pv-video"
                  muted
                  autoPlay
                  playsInline
                  preload="auto"
                  onEnded={(event) => {
                    if (socialPreviewClips.length <= 1) {
                      event.currentTarget.currentTime = 0
                      void event.currentTarget.play?.()
                      return
                    }
                    setSocialPreviewClipIndex((index) => (index + 1) % socialPreviewClips.length)
                  }}
                />
                <div className="pv-sequence-badge">
                  rough cut {activePreviewClip.index + 1}/{planShots.length}
                </div>
              </>
            ) : (
              <div className="pv-center">
                <div className="hook-line">"{previewHook}"</div>
                <div className="sub">{selectedGoal.label} / {commercialLength}s / {shotCount} shots</div>
              </div>
            )}
            <div className="pv-actions" aria-hidden="true">
              <div>♡<span className="cnt">24.1k</span></div>
              <div>💬<span className="cnt">312</span></div>
              <div>↗<span className="cnt">1.8k</span></div>
            </div>
            {!oneShotAssetUrl && (
              <>
                <div className="pv-caption">
                  <div className="user">@{brandHandle}</div>
                  <div>{activePreviewClip ? `Shot ${activePreviewClip.index + 1}: ${activePreviewClip.caption}` : 'this is the one everyone keeps asking me about #ad'}</div>
                </div>
                <div className="pv-sound">
                  ♪ <span>original sound - your ad, but make it feel native</span>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="ugc-side-card">
          <div className="ugc-side-title">The brief so far</div>
          <div className="ugc-summary-list">
            <div className="ugc-summary-item"><span className="ugc-summary-label">Format</span><span>{selectedGoal.label}</span></div>
            <div className="ugc-summary-item"><span className="ugc-summary-label">Vibe</span><span>{selectedTone.label}</span></div>
            <div className="ugc-summary-item"><span className="ugc-summary-label">Canvas</span><span>{selectedAspectRatio.label} / {resolutionPreset}</span></div>
            <div className="ugc-summary-item"><span className="ugc-summary-label">Cut</span><span>{commercialLength}s / {shotCount} shots / {FIXED_UGC_FPS}fps</span></div>
            <div className="ugc-summary-item"><span className="ugc-summary-label">Keyframes</span><span>{selectedKeyframeWorkflow.label}</span></div>
            <div className="ugc-summary-item"><span className="ugc-summary-label">Video</span><span>{selectedVideoWorkflow.label}</span></div>
          </div>
        </div>

        <div className="ugc-side-card">
          <div className="ugc-side-title">Why this works</div>
          <div className="ugc-card-copy">
            UGC ads work when they feel native to the feed. The defaults here favor handheld framing, real skin tones, clear product handling, and editable shot-by-shot control.
          </div>
          <div className="ugc-tag-row">
            <span className="ugc-tag pink">dialogue beats</span>
            <span className="ugc-tag cyan">product moments</span>
            <span className="ugc-tag lime">editable clips</span>
          </div>
        </div>
      </aside>
    )
  }

  const renderActions = (back, next, nextLabel) => (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <button
        type="button"
        onClick={() => setStep(back)}
        className="rounded-lg border border-[#2e2c26] px-3 py-2 text-xs text-[#c9c6ba] hover:border-[#4a473e] hover:text-[#f1efe8]"
      >
        Back
      </button>
      <button
        type="button"
        onClick={() => goTo(next)}
        className="ugc-primary rounded-lg px-3 py-2 text-xs font-semibold"
      >
        {nextLabel}
      </button>
    </div>
  )

  return (
    <div className="ugc-human-theme">
      <style>{UGC_HUMAN_THEME_CSS}</style>
      <div className="ugc-topbar">
        <div>
          <div className="ugc-crumb">Generate / Ads / UGC Creator</div>
          <h1 className="ugc-top-title">UGC Creator <span>- social ads that still feel human</span></h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="ugc-pill"><span className="ugc-dot" />ComfyUI connected</span>
          <span className="ugc-pill hot">Beta workflow</span>
        </div>
      </div>
      {renderStepNav()}
      <div className="ugc-layout">
        <section className="min-w-0">

      {step === 'setup' && (
        <div>
          <div className="ugc-section-head">
            <span className="ugc-kicker">The Vibe</span>
            <h2 className="ugc-section-title">Make it look like a friend posted it.</h2>
            <p className="ugc-section-copy">
              Pick the kind of post, write the hook, and tell Velorn what is being sold. The workflow turns that into editable dialogue, keyframes, video clips, and a timeline.
            </p>
          </div>

          <div className="ugc-card-block">
            <div className="ugc-card-title">Pick a starting template</div>
            <div className="ugc-card-copy">Each one writes a full default script — shots, dialogue, and camera — as a starting point. Pick the closest, then customize the prompt on the Generate step. These are templates, not locked formats; the real ad is yours to edit.</div>
            <div className="ugc-format-grid">
              {UGC_FORMAT_OPTIONS.map(renderFormatButton)}
            </div>
          </div>

          <div className="ugc-hook-hero">
            <label htmlFor="ugc-hook-input">The hook - first 2 seconds</label>
            <input
              id="ugc-hook-input"
              value={hook}
              onChange={(e) => setHook(e.target.value)}
              className="ugc-hook-input"
              placeholder='"Okay, I need to show you this..."'
            />
            <div className="ugc-chip-row">
              {HOOK_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setHook(suggestion)}
                  className="ugc-chip"
                >
                  "{suggestion}"
                </button>
              ))}
              <button
                type="button"
                onClick={() => setHook(HOOK_SUGGESTIONS[Math.floor(Math.random() * HOOK_SUGGESTIONS.length)])}
                className="ugc-chip active"
              >
                surprise me
              </button>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="ugc-card-block">
              <div className="ugc-card-title">What are we selling?</div>
              <div className="ugc-card-copy">The one thing that's in every shot.</div>
              <label className="mt-3 block">
                <span className="ugc-field-label">Product</span>
                <input value={productService} onChange={(e) => setProductService(e.target.value)} className="ugc-input w-full rounded-lg border px-3 py-2 text-xs" placeholder="What are you selling? e.g. a can of Red Bull" />
              </label>
            </div>

            <div className="ugc-card-block">
              <div className="ugc-card-title">Creator energy</div>
              <div className="ugc-card-copy">How does the person on camera feel?</div>
              <div className="ugc-chip-row">
                {TONE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setTone(option.id)}
                    className={`ugc-chip ${tone === option.id ? 'active' : ''}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3">
            <div className="ugc-card-block">
              <div className="ugc-card-title">Delivery</div>
              <div className="ugc-field-label mt-1">Canvas</div>
              <div className="ugc-toggle-row">
                {ASPECT_RATIO_OPTIONS.map((option) => (
                  <button
                    key={`aspect-${option.id}`}
                    type="button"
                    onClick={() => {
                      setPlatform(option.id)
                      const nextResolution = resolveOutputResolution(option.id, resolutionPreset)
                      setResolution(nextResolution)
                      setImageResolution(nextResolution)
                    }}
                    className={`ugc-toggle ${platform === option.id ? 'selected' : ''}`}
                  >
                    {option.id === 'vertical_9x16' ? '9:16 - TikTok - Reels' : option.id === 'square_1x1' ? '1:1 - Feed post' : '16:9 - YouTube'}
                  </button>
                ))}
              </div>
              <label className="mt-4 block">
                <span className="ugc-field-label">How long?</span>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={MIN_UGC_LENGTH_SECONDS}
                    max={MAX_UGC_LENGTH_SECONDS}
                    step="1"
                    value={commercialLength}
                    onChange={(event) => updateLength(event.target.value)}
                    className="ugc-input w-28 rounded-lg border px-3 py-2 text-xs"
                  />
                  <span className="text-xs text-[#c9c6ba]">seconds</span>
                </div>
                <span className="mt-1 block text-[10px] text-[#95927f]">
                  Recommended {RECOMMENDED_UGC_LENGTH_MIN}-{RECOMMENDED_UGC_LENGTH_MAX}s. One-shot generation caps at 15s.
                </span>
              </label>
              <div className="ugc-field-label mt-4">Quality</div>
              <div className="ugc-toggle-row">
                {RESOLUTION_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setResolutionPreset(option.id)
                      const nextResolution = resolveOutputResolution(platform, option.id)
                      setResolution(nextResolution)
                      setImageResolution(nextResolution)
                    }}
                    className={`ugc-toggle ${resolutionPreset === option.id ? 'selected' : ''}`}
                  >
                    {option.id === '720p' ? '720p - faster' : '1080p - sharper'}
                  </button>
                ))}
              </div>
              <div className="ugc-field-label mt-4">Frame rate</div>
              <div className="ugc-tag-row">
                <span className="ugc-tag cyan">{FIXED_UGC_FPS} fps</span>
                <span className="text-[11px] text-[#95927f]">Locked to 25 fps — LTX 2.3's native rate for clean motion and lip-sync.</span>
              </div>
            </div>
          </div>

          {/* "Add detail" fields hidden for now — the one-shot flow steers via the
              prompt/AI instead. State + sensible defaults still feed the script.
              Re-enable by flipping this false to true. */}
          {false && (
          <details className="ugc-card-block mt-3">
            <summary className="cursor-pointer select-none text-sm font-semibold text-[#f1efe8]">
              Add detail <span className="ml-2 font-mono text-[10px] font-normal uppercase tracking-wider text-[#95927f]">optional - good defaults already set</span>
            </summary>
            <p className="ugc-card-copy mt-2">All optional. Leave them and the workflow fills in sensible defaults; add any to steer the result. You can also tweak every line later in Script Review.</p>
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <label className="block">
                <span className="ugc-field-label">Brand</span>
                <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} className="ugc-input w-full rounded-lg border px-3 py-2 text-xs" placeholder="Your brand name" />
              </label>
              <label className="block">
                <span className="ugc-field-label">Who's scrolling past? (your audience)</span>
                <input value={audience} onChange={(e) => setAudience(e.target.value)} className="ugc-input w-full rounded-lg border px-3 py-2 text-xs" placeholder="Who is this for? e.g. busy people who want a quick win" />
              </label>
              <label className="block lg:col-span-2">
                <span className="ugc-field-label">Why should they stop scrolling?</span>
                <textarea value={offer} onChange={(e) => setOffer(e.target.value)} rows={2} className="ugc-input w-full resize-y rounded-lg border px-3 py-2 text-xs" placeholder="The one reason to care - the payoff in plain words." />
              </label>
              <label className="block lg:col-span-2">
                <span className="ugc-field-label">The proof moment - what convinces people it's real?</span>
                <textarea value={proof} onChange={(e) => setProof(e.target.value)} rows={2} className="ugc-input w-full resize-y rounded-lg border px-3 py-2 text-xs" placeholder="The believable beat - a demo, before/after, or honest reaction." />
              </label>
              <label className="block lg:col-span-2">
                <span className="ugc-field-label">Creator direction</span>
                <textarea value={talentDirection} onChange={(e) => setTalentDirection(e.target.value)} rows={2} className="ugc-input w-full resize-y rounded-lg border px-3 py-2 text-xs" placeholder="mid-20s creator, talks like a friend, slightly skeptical then impressed" />
              </label>
              <label className="block">
                <span className="ugc-field-label">Room / location</span>
                <input value={location} onChange={(e) => setLocation(e.target.value)} className="ugc-input w-full rounded-lg border px-3 py-2 text-xs" />
              </label>
              <label className="block">
                <span className="ugc-field-label">Final line / CTA</span>
                <input value={cta} onChange={(e) => setCta(e.target.value)} className="ugc-input w-full rounded-lg border px-3 py-2 text-xs" />
              </label>
              <label className="block lg:col-span-2">
                <span className="ugc-field-label">Camera rules</span>
                <textarea value={visualRules} onChange={(e) => setVisualRules(e.target.value)} rows={2} className="ugc-input w-full resize-y rounded-lg border px-3 py-2 text-xs" />
              </label>
            </div>
          </details>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-[#95927f]">Format, hook, product, and tone are all you need — fine-tune the full script on the Generate step.</span>
            <button type="button" onClick={() => goTo('references')} className="ugc-primary rounded-lg px-4 py-2 text-xs font-semibold">
              Next: add references
            </button>
          </div>
        </div>
      )}

      {step === 'references' && (
        <div className="ugc-card-block space-y-4">
          <div>
            <div className="ugc-kicker">Drop-ins</div>
            <h2 className="ugc-section-title">Anchor the product, creator, and room.</h2>
            <p className="ugc-section-copy">These are optional, but UGC gets more believable when the AI has real references for the product, person, and phone-camera environment.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="ugc-card-block">
              <div className="text-2xl" aria-hidden="true">🧴</div>
              <div className="mt-2 text-sm font-semibold text-[#f1efe8]">The Product</div>
              <p className="mt-1 text-[11px] leading-4 text-[#95927f]">Packaging shots, close-ups, app screens - anything that locks the product identity.</p>
              <select value={productAssetId} onChange={(e) => setProductAssetId(e.target.value)} className="mt-3 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none">
                <option value="">No product asset selected</option>
                {imageAssets.map((asset) => <option key={`easy-product-${asset.id}`} value={asset.id}>{asset.name}</option>)}
              </select>
            </div>
            <div className="ugc-card-block">
              <div className="text-2xl" aria-hidden="true">🤳</div>
              <div className="flex items-center justify-between gap-2">
                <div className="mt-2 text-sm font-semibold text-[#f1efe8]">The Creator</div>
                <label className="flex items-center gap-1.5 text-[10px] text-sf-text-muted">
                  <input type="checkbox" checked={noVisibleTalent} onChange={(e) => setNoVisibleTalent(e.target.checked)} />
                  Hands only / no face
                </label>
              </div>
              <p className="mt-1 text-[11px] leading-4 text-[#95927f]">Creator or avatar image with outfit, expressions, social-camera personality.</p>
              <select disabled={noVisibleTalent} value={talentAssetId} onChange={(e) => setTalentAssetId(e.target.value)} className="mt-3 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none disabled:opacity-50">
                <option value="">No creator asset selected</option>
                {imageAssets.map((asset) => <option key={`easy-creator-${asset.id}`} value={asset.id}>{asset.name}</option>)}
              </select>
            </div>
            <div className="ugc-card-block">
              <div className="text-2xl" aria-hidden="true">🛁</div>
              <div className="mt-2 text-sm font-semibold text-[#f1efe8]">The Room</div>
              <p className="mt-1 text-[11px] leading-4 text-[#95927f]">Bathroom, kitchen, desk, gym - the world the phone lives in.</p>
              <select value={environmentAssetId} onChange={(e) => setEnvironmentAssetId(e.target.value)} className="mt-3 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none">
                <option value="">No room asset selected</option>
                {imageAssets.map((asset) => <option key={`easy-environment-${asset.id}`} value={asset.id}>{asset.name}</option>)}
              </select>
            </div>
          </div>
          <div className="rounded-lg border border-[#e3a94f]/30 bg-[#e3a94f]/10 px-3 py-2">
            <div className="text-[11px] font-bold text-[#e3a94f]">Pro move</div>
            <div className="mt-1 text-[11px] leading-5 text-[#c9c6ba]">
              A creator reference plus a room reference keeps the same person in the same place across shots. That continuity is what makes UGC ads feel real instead of stitched together.
            </div>
          </div>
          {renderActions('setup', 'generate', 'Build Prompt')}
        </div>
      )}

      {step === 'script' && (
        <div className="ugc-panel space-y-4 rounded-2xl border p-4">
          <div>
            <div className="ugc-kicker">Script Review</div>
            <h2 className="ugc-section-title">Your shot list.</h2>
            <p className="ugc-section-copy">
              Each card is one shot. The line the creator says is the headline; the camera and on-screen action sit underneath. Flip to <b>Just the lines</b> for a quick read-through. Shot 1 is your hook from Step 1, and any shot can be a silent product moment. The full director script stays in sync below.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="ugc-card rounded-lg border px-3 py-2">
              <div className="ugc-card-title">Shot plan</div>
              <div className="ugc-card-copy">Length sets the suggested number of shots. Adjust it and the shot list updates.</div>
            </div>
            <label className="text-xs text-[#c9c6ba]">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#95927f]">How many shots? ({commercialLength}s ad)</span>
              <select value={shotCount} onChange={(e) => updateShotCount(e.target.value)} className="ugc-input mt-1 w-full rounded-lg border px-3 py-2 text-xs">
                {SHOT_COUNT_OPTIONS.map((count) => <option key={count} value={count}>{count} shots</option>)}
              </select>
              <span className="mt-1 block text-[10px] text-[#95927f]">{getShotHint(commercialLength)}</span>
            </label>
            <div className="ugc-card rounded-lg border px-3 py-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#95927f]">Model route</div>
              <div className="mt-1 text-xs text-[#f1efe8]">{selectedKeyframeWorkflow.label} keyframes + {selectedVideoWorkflow.label} video</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#2e2c26] bg-[#100f0d] p-2">
            <div className="text-xs text-[#c9c6ba]">
              {scriptReviewShots.length} editable creator beats. Each shot is about {getShotDuration(shotCount, commercialLength)} seconds.
            </div>
            <div className="flex rounded-md border border-[#2e2c26] bg-[#161512] p-1">
              <button
                type="button"
                onClick={() => setScriptViewMode('full')}
                className={`rounded px-3 py-1.5 text-[11px] font-semibold ${scriptViewMode === 'full' ? 'bg-[#ff4b2e] text-white' : 'text-[#95927f] hover:text-[#f1efe8]'}`}
              >
                Full shot
              </button>
              <button
                type="button"
                onClick={() => setScriptViewMode('lines')}
                className={`rounded px-3 py-1.5 text-[11px] font-semibold ${scriptViewMode === 'lines' ? 'bg-[#ff4b2e] text-white' : 'text-[#95927f] hover:text-[#f1efe8]'}`}
              >
                Just the lines
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {scriptReviewShots.map((shot, index) => {
              const noLine = shotHasNoDialogue(shot)
              return (
                <div key={`ugc-script-shot-${index}`} className="ugc-card rounded-xl border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#ffb4a3]">
                        Shot {index + 1} / {formatShotTime(index, scriptReviewShots.length, Number(commercialLength) || 15)}
                      </div>
                      <div className="mt-1 text-sm font-semibold text-[#f1efe8]">{shot.title}</div>
                      <div className="mt-1 text-[11px] text-[#95927f]">{shot.adBeat} / {shot.productMode} / {shot.shotType}</div>
                    </div>
                    <label className="flex items-center gap-2 rounded border border-[#2e2c26] bg-[#100f0d] px-2 py-1 text-[10px] text-[#c9c6ba]">
                      <input
                        type="checkbox"
                        checked={noLine}
                        onChange={(event) => toggleScriptShotNoLine(index, event.target.checked)}
                      />
                      No line - product moment
                    </label>
                  </div>
                  <div className={`mt-3 grid gap-3 ${scriptViewMode === 'full' ? 'lg:grid-cols-[1fr_1fr]' : ''}`}>
                    <label className="text-xs text-[#c9c6ba]">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-[#95927f]">Creator line</span>
                      <textarea
                        value={noLine ? '' : stripDialogueQuotes(shot.dialogue)}
                        onChange={(event) => updateScriptShotOverride(index, 'dialogue', event.target.value)}
                        disabled={noLine}
                        rows={scriptViewMode === 'lines' ? 2 : 3}
                        placeholder="What does the creator say?"
                        className="ugc-input mt-1 w-full resize-y rounded-lg border px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </label>
                    {scriptViewMode === 'full' && (
                      <div className="grid gap-3">
                        <label className="text-xs text-[#c9c6ba]">
                          <span className="font-mono text-[10px] uppercase tracking-wider text-[#95927f]">Product action</span>
                          <textarea
                            value={shot.productAction || ''}
                            onChange={(event) => updateScriptShotOverride(index, 'productAction', event.target.value)}
                            rows={2}
                            className="ugc-input mt-1 w-full resize-y rounded-lg border px-3 py-2 text-xs"
                          />
                        </label>
                        <label className="text-xs text-[#c9c6ba]">
                          <span className="font-mono text-[10px] uppercase tracking-wider text-[#95927f]">Camera mode</span>
                          <input
                            value={shot.camera || ''}
                            onChange={(event) => updateScriptShotOverride(index, 'camera', event.target.value)}
                            className="ugc-input mt-1 w-full rounded-lg border px-3 py-2 text-xs"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                  {scriptViewMode === 'full' && (
                    <div className="mt-3 grid gap-2 border-t border-[#2e2c26] pt-3 md:grid-cols-2">
                      <div className="rounded border border-[#2e2c26] bg-[#100f0d] p-2">
                        <div className="font-mono text-[9px] uppercase tracking-wider text-[#95927f]">Keyframe prompt</div>
                        <div className="mt-1 line-clamp-3 text-[11px] leading-4 text-[#c9c6ba]">{shot.keyframe}</div>
                      </div>
                      <div className="rounded border border-[#2e2c26] bg-[#100f0d] p-2">
                        <div className="font-mono text-[9px] uppercase tracking-wider text-[#95927f]">Motion prompt</div>
                        <div className="mt-1 line-clamp-3 text-[11px] leading-4 text-[#c9c6ba]">{shot.motion}</div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <details className="ugc-card rounded-xl border p-3">
            <summary className="cursor-pointer select-none text-sm font-semibold text-[#f1efe8]">
              Advanced - raw director script
              <span className="ml-2 font-mono text-[10px] font-normal uppercase tracking-wider text-[#95927f]">kept in sync</span>
            </summary>
            <div className="mt-3 rounded-xl border border-[#2e2c26] bg-[#100f0d] p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#ffb4a3]">Optional: use your own LLM</div>
                  <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-[#95927f]">
                    Copy this prompt into ChatGPT, Claude, Gemini, or another LLM, then paste the result back into the editable Director Script below.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {llmCopyStatus && <span className="text-[10px] text-[#95927f]">{llmCopyStatus}</span>}
                  <button
                    type="button"
                    onClick={copyExternalLlmPrompt}
                    className="rounded-lg border border-[#4a473e] bg-[#1b1a17] px-3 py-2 text-xs text-[#ffb4a3] transition-colors hover:border-[#ff4b2e]"
                  >
                    Copy LLM Prompt
                  </button>
                </div>
              </div>
              <textarea
                readOnly
                value={externalLlmPrompt}
                rows={7}
                spellCheck={false}
                onFocus={(event) => event.target.select()}
                onClick={(event) => event.target.select()}
                className="ugc-input mt-3 w-full resize-y rounded-lg border px-3 py-2 font-mono text-[10px] leading-5"
              />
            </div>
            <textarea
              value={scriptManuallyEdited ? directorScript : generatedScript}
              onChange={(e) => {
                setScriptManuallyEdited(true)
                setDirectorScript(e.target.value)
                setYoloScript(e.target.value)
              }}
              rows={18}
              spellCheck={false}
              className="ugc-input mt-3 w-full resize-y rounded-lg border px-3 py-2 font-mono text-[11px] leading-5"
            />
          </details>

          <div className="rounded-lg border border-[#e3a94f]/30 bg-[#e3a94f]/10 px-3 py-2 text-[11px] leading-relaxed text-[#f6d7a6]">
            Read the creator lines out loud. If a line sounds like an ad, rewrite it like a text to a friend. Silent product moments are fine - real UGC isn't talking the whole way through.
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => setStep('references')} className="rounded-lg border border-[#2e2c26] px-3 py-2 text-xs text-[#c9c6ba] hover:border-[#4a473e] hover:text-[#f1efe8]">Back</button>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setScriptManuallyEdited(false)
                  setScriptShotOverrides({})
                  const next = buildDirectorScript(currentData)
                  setDirectorScript(next)
                  applyToDirector(next)
                }}
                className="rounded-lg border border-[#2e2c26] px-3 py-2 text-xs text-[#c9c6ba] hover:border-[#4a473e] hover:text-[#f1efe8]"
              >
                Rebuild from brief
              </button>
              <button type="button" onClick={handleBuildPlan} disabled={isQueuingKeyframes || isQueuingVideos} className="ugc-primary rounded-lg px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50">
                Create keyframes
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'voiceover' && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-4">
          <div>
            <div className="ugc-kicker">One Voice, Every Shot</div>
            <h2 className="mt-1 text-lg font-semibold text-sf-text-primary">Give the creator a single, consistent voice.</h2>
            <p className="mt-1 text-xs text-sf-text-muted">
              Pick one voice and generate a clip for every spoken line. LTX 2.3 lip-syncs to these clips, so the creator sounds identical across all shots instead of inventing a new voice per clip. Silent shots stay silent — add music or SFX yourself in the editor.
            </p>
          </div>

          {planShots.length === 0 ? (
            <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/40 px-3 py-3 text-xs text-sf-text-muted">
              Build the plan first (Script Review → Create keyframes), then come back to add voices.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {renderChoiceButton(voiceMode === 'generate', 'Generate voices', () => setVoiceMode('generate'), 'One pinned voice for the whole ad, generated with ElevenLabs.', 'voice-generate')}
                {renderChoiceButton(voiceMode === 'none', 'No voice', () => setVoiceMode('none'), 'Skip voices. Every shot stays silent for you to score yourself.', 'voice-none')}
              </div>

              {voiceMode === 'generate' && (
                <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3 space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block text-xs text-sf-text-secondary">
                      <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Creator voice</span>
                      <select
                        value={voiceId}
                        onChange={(event) => setVoiceId(event.target.value)}
                        className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
                      >
                        {VOICE_OPTIONS.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs text-sf-text-secondary">
                      <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Model</span>
                      <select
                        value={voiceModel}
                        onChange={(event) => setVoiceModel(event.target.value)}
                        className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
                      >
                        {VOICE_MODEL_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900/50 px-3 py-2">
                    <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Hear it</span>
                    {previewCache[voiceId] ? (
                      <audio key={voiceId} src={previewCache[voiceId]} controls className="h-7 max-w-[220px]" />
                    ) : (
                      <span className="text-[10px] italic text-sf-text-muted">No sample yet for this voice.</span>
                    )}
                    <button
                      type="button"
                      disabled={isGeneratingPreviews || yoloDependencyCheckInProgress || cachedPreviewCount >= VOICE_OPTIONS.length}
                      onClick={handleGenerateVoicePreviews}
                      className="rounded-lg border border-sf-dark-600 px-2.5 py-1 text-[10px] text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isGeneratingPreviews
                        ? 'Generating…'
                        : cachedPreviewCount >= VOICE_OPTIONS.length
                          ? 'All previews ready'
                          : `Generate voice previews (${cachedPreviewCount}/${VOICE_OPTIONS.length})`}
                    </button>
                    <span className="text-[10px] text-sf-text-muted">One-time, cached for every project.</span>
                  </div>
                  <label className="block text-xs text-sf-text-secondary">
                    <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Expressiveness</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round((1 - voiceStability) * 100)}
                      onChange={(event) => setVoiceStability(1 - (Number(event.target.value) / 100))}
                      className="mt-1 w-full accent-sf-accent"
                    />
                    <span className="text-[10px] text-sf-text-muted">More emotional &amp; variable ⟵ ⟶ more consistent &amp; steady (stability {voiceStability.toFixed(2)})</span>
                  </label>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      disabled={isQueuingVoices || yoloDependencyCheckInProgress || voiceLineShots.length === 0}
                      onClick={handleGenerateAllVoices}
                      className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isQueuingVoices ? 'Queueing voices...' : `Generate ${voiceLineShots.length} Voice${voiceLineShots.length === 1 ? '' : 's'}`}
                    </button>
                    <span className="text-[10px] text-sf-text-muted">{voiceReadyCount}/{voiceLineShots.length} ready</span>
                  </div>
                  {voiceStatus && <div className="text-[10px] text-sf-text-muted">{voiceStatus}</div>}

                  <div className="space-y-2">
                    {planShots.map(({ scene, shot }, index) => {
                      const variant = getFirstVariantForShot(scene.id, shot.id)
                      const silent = shotHasNoDialogue(shot)
                      const voiceAsset = variant ? yoloUgcVoiceAssetMap?.get(variant.key) : null
                      const clipUrl = getAssetUrl(voiceAsset)
                      const line = stripDialogueQuotes(shot.dialogue || '')
                      const isRegenerating = variant && regeneratingVoiceKey === variant.key
                      return (
                        <div key={`voice-${scene.id}-${shot.id}`} className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/50 px-3 py-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Shot {index + 1}</div>
                              <div className={`mt-0.5 text-xs ${silent ? 'italic text-sf-text-muted' : 'text-sf-text-primary'}`}>
                                {silent ? 'Silent — no spoken line' : (line || '(no line yet)')}
                              </div>
                            </div>
                            <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] ${
                              silent
                                ? 'border-sf-dark-600 text-sf-text-muted'
                                : clipUrl
                                  ? 'border-emerald-500/40 text-emerald-200'
                                  : 'border-yellow-500/40 text-yellow-100'
                            }`}>
                              {silent ? 'Silent' : clipUrl ? 'Voice ready' : 'No voice yet'}
                            </span>
                          </div>
                          {!silent && (
                            <div className="mt-2 space-y-2">
                              {voiceModel === 'eleven_v3' && (
                                <input
                                  type="text"
                                  value={voiceDelivery[shot.id] || ''}
                                  onChange={(event) => setVoiceDelivery((prev) => ({ ...prev, [shot.id]: event.target.value }))}
                                  placeholder="Delivery, e.g. excited, breathless / skeptical / warm and amazed"
                                  className="w-full rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-1.5 text-[11px] text-sf-text-primary placeholder:italic placeholder:text-sf-text-muted/70 focus:border-sf-accent focus:outline-none"
                                />
                              )}
                              <div className="flex flex-wrap items-center gap-2">
                                {clipUrl && (
                                  <audio key={clipUrl} src={clipUrl} controls className="h-7 max-w-[220px]" />
                                )}
                                <button
                                  type="button"
                                  disabled={isQueuingVoices || isRegenerating || yoloDependencyCheckInProgress || !line}
                                  onClick={() => handleRegenerateVoiceLine(scene, shot)}
                                  className="rounded-lg border border-sf-dark-600 px-2.5 py-1 text-[10px] text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {isRegenerating ? 'Queueing…' : clipUrl ? 'New take' : 'Generate this line'}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <p className="text-[10px] text-sf-text-muted">
                    Tweak delivery and hit “New take” until a line sounds right, then move on. Change the words in Script Review. With a voice clip, LTX 2.3 voiced shots auto-route to the lip-sync graph (audio + lips in one clip). Seedance also lip-syncs to the clip but outputs silent video — lay the clip on the timeline.
                  </p>
                </div>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => setStep('script')} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Back</button>
            <button type="button" disabled={planShots.length === 0} onClick={() => setStep('keyframes')} className="ugc-primary rounded-lg px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50">Next: Keyframes</button>
          </div>
        </div>
      )}

      {step === 'generate' && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-4">
          <div>
            <div className="ugc-kicker">One-Shot</div>
            <h2 className="mt-1 text-lg font-semibold text-sf-text-primary">Generate the whole ad in one pass.</h2>
            <p className="mt-1 text-xs text-sf-text-muted">
              Seedance 2.0 takes your full prompt + the references and builds the entire ad — all the cuts, performance, and native audio — in a single clip. Pick a length, review the prompt, and generate.
            </p>
          </div>

          <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3 space-y-3">
            <div className="flex flex-wrap items-center gap-4">
              <div className="text-[10px] text-sf-text-muted">
                <div className="uppercase tracking-wider">Length</div>
                <div className="mt-1 text-sf-text-secondary">{oneShotDuration}s · set it in The Vibe</div>
              </div>
              <div className="text-[10px] text-sf-text-muted">
                <div className="uppercase tracking-wider">References</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <span className={`rounded-full border px-2 py-0.5 ${productAssetId ? 'border-emerald-500/40 text-emerald-200' : 'border-sf-dark-600 text-sf-text-muted'}`}>Product {productAssetId ? '✓' : '—'}</span>
                  <span className={`rounded-full border px-2 py-0.5 ${(noVisibleTalent || talentAssetId) ? 'border-emerald-500/40 text-emerald-200' : 'border-sf-dark-600 text-sf-text-muted'}`}>Creator {noVisibleTalent ? '(none)' : talentAssetId ? '✓' : '—'}</span>
                  <span className={`rounded-full border px-2 py-0.5 ${environmentAssetId ? 'border-emerald-500/40 text-emerald-200' : 'border-sf-dark-600 text-sf-text-muted'}`}>Environment {environmentAssetId ? '✓' : '—'}</span>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/50 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-sf-accent">Tailor it with AI (free)</div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-sf-text-muted">
                    Copy this {selectedGoal.label} template's prompt, paste it into ChatGPT / Claude / Gemini / any LLM (or your own), then paste the result into the box below. It rewrites the script for your exact product — no credits, your choice of model.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {llmCopyStatus && <span className="text-[10px] text-sf-text-muted">{llmCopyStatus}</span>}
                  <button
                    type="button"
                    onClick={copyExternalLlmPrompt}
                    className="rounded-lg border border-sf-dark-600 bg-sf-dark-700 px-2.5 py-1.5 text-[11px] font-medium text-sf-text-primary transition-colors hover:bg-sf-dark-600"
                  >
                    Copy AI script prompt
                  </button>
                </div>
              </div>
            </div>

            <label className="block text-xs text-sf-text-secondary">
              <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Ad prompt (the whole script)</span>
              <textarea
                value={oneShotPrompt || ''}
                onChange={(event) => { setScriptManuallyEdited(true); setDirectorScript(event.target.value) }}
                rows={12}
                className="mt-1 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs leading-relaxed text-sf-text-primary focus:border-sf-accent focus:outline-none"
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => { setScriptManuallyEdited(false); setScriptShotOverrides({}); const next = buildDirectorScript(currentData); setDirectorScript(next); applyToDirector(next) }}
                className="rounded-lg border border-sf-dark-600 bg-sf-dark-700 px-3 py-2 text-xs font-medium text-sf-text-primary transition-colors hover:bg-sf-dark-600"
              >
                Rebuild from brief
              </button>
              <button
                type="button"
                disabled={isGeneratingOneShot || yoloDependencyCheckInProgress || !String(oneShotPrompt || '').trim()}
                onClick={() => handleGenerateOneShot('seedance')}
                title="Cloud Seedance 2.0 — uses your references to lock the product and creator. The quality path."
                className="ugc-primary rounded-lg px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isGeneratingOneShot ? 'Queueing…' : `Generate (Seedance 2.0, ${oneShotDuration}s)`}
              </button>
              <button
                type="button"
                disabled={isGeneratingOneShot || yoloDependencyCheckInProgress || !String(oneShotPrompt || '').trim()}
                onClick={() => handleGenerateOneShot('ltx')}
                title="Local LTX 2.3 — composes a first frame from your references, then animates it (one continuous shot). Slower on local GPUs."
                className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isGeneratingOneShot ? 'Queueing…' : `Generate (LTX 2.3 local, ${oneShotDuration}s)`}
              </button>
              <span className="text-[10px] text-sf-text-muted">{oneShotStatus}</span>
            </div>
            <p className="text-[10px] text-sf-text-muted">
              Seedance (cloud) uses your references to lock the product and creator with true scene cuts. LTX 2.3 (local) auto-composes a first frame from your references, then animates it — one continuous shot, kept on your own GPU. (No references? LTX falls back to prompt-only.)
            </p>
          </div>

          {oneShotAssetUrl && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[10px] text-sf-text-muted">
              Your ad is ready — hit play in the <span className="text-emerald-200">Social preview</span> to watch it. Saved to your project assets too; drag it onto the timeline to edit or export. Not happy? Tweak the prompt and generate again.
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => setStep('references')} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Back</button>
            <button type="button" onClick={() => setStep('setup')} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Start Another Ad</button>
          </div>
        </div>
      )}

      {step === 'keyframes' && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-4">
          <div>
            <div className="ugc-kicker">Shots</div>
            <h2 className="mt-1 text-lg font-semibold text-sf-text-primary">
              {keyframeGeneratingCount > 0
                ? `Generating keyframes (${yoloStoryboardReadyCount}/${planShots.length} ready).`
                : yoloStoryboardReadyCount > 0
                  ? 'Review your generated keyframes.'
                  : 'Generate the keyframes.'}
            </h2>
            <p className="mt-1 text-xs text-sf-text-muted">
              Each phone card is one shot. Cards update as keyframes finish. Select a shot to tweak its prompt and regenerate only that shot.
            </p>
          </div>
          <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">Keyframe model</div>
                <div className="mt-1 text-sm font-semibold text-sf-text-primary">Using {selectedKeyframeWorkflow.label}</div>
              </div>
              <div className="grid min-w-[260px] flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                {KEYFRAME_MODEL_OPTIONS.map((option) => renderChoiceButton(
                  keyframeWorkflowId === option.id,
                  `${option.label} (${option.runtimeLabel})`,
                  () => handleKeyframeWorkflowChange(option.id),
                  option.helper,
                  `easy-keyframe-review-route-${option.id}`
                ))}
              </div>
            </div>
            {keyframeReferenceMissing && (
              <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100/90">
                {selectedKeyframeWorkflow.label} needs a product, creator, or environment reference image before it can queue keyframes.
              </div>
            )}
            {renderCustomKeyframeWorkflowPanel()}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-sf-text-muted">Ready to create all planned keyframes with {selectedKeyframeWorkflow.label}.</span>
              <button
                type="button"
                disabled={yoloDependencyCheckInProgress || keyframeReferenceMissing || customKeyframeNeedsSetup}
                onClick={() => {
                  setKeyframeStatus(`Queued ${selectedKeyframeWorkflow.label} keyframes for all planned shots.`)
                  void handleQueueYoloStoryboards({
                    resolutionOverride: outputResolution,
                    ...getKeyframeReferenceOverrides(),
                    storyboardReferenceAssetIdsOverride: getKeyframeReferenceAssetIds(),
                    storyboardWorkflowIdOverride: selectedKeyframeWorkflow.workflowId,
                    sourceLabel: `UGC Creator ${selectedKeyframeWorkflow.label} keyframe pass`,
                  })
                }}
                className="ugc-primary rounded-lg px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              >
                Generate keyframes
              </button>
            </div>
          </div>
          {planShots.length === 0 ? (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">Build the script plan first.</div>
          ) : (
            <>
              <div className="phone-grid">
                {planShots.map(({ scene, shot }, index) => {
                  const variant = getFirstVariantForShot(scene.id, shot.id)
                  const asset = variant ? yoloStoryboardAssetMap?.get(variant.key) : null
                  const url = getAssetUrl(asset)
                  const cardState = getKeyframeCardState(variant, asset)
                  const statusClass = cardState.state === 'ready'
                    ? 'ready'
                    : cardState.state === 'generating'
                      ? 'generating'
                      : cardState.state === 'error'
                        ? 'error'
                        : 'pending'
                  const fillClass = cardState.state === 'ready'
                    ? `ready-${(index % 3) + 1}`
                    : cardState.state === 'generating'
                      ? 'generating'
                      : ''
                  return (
                    <button
                      key={`easy-keyframe-${scene.id}-${shot.id}`}
                      type="button"
                      onClick={() => setSelectedShotIndex(index)}
                      className={`phone-card ${selectedShotIndex === index ? 'selected' : ''}`}
                    >
                      <span className="phone-shell">
                        <span className="notch" />
                        {url ? (
                          <img src={url} alt="" className="absolute inset-0 h-full w-full object-contain bg-black" />
                        ) : (
                          <>
                            {cardState.state === 'generating' && (
                              <span className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                            )}
                            <span className={`phone-fill ${fillClass}`}>
                              {cardState.label}
                            </span>
                          </>
                        )}
                        <span className={`phone-status ${statusClass}`}>{cardState.label.replace(/^Keyframe\s+/i, '')}</span>
                      </span>
                      <span className="phone-meta">
                        <span className="shot-name">{index + 1} - {shot.id}</span>
                        <span className="shot-line">{shot.imageBeat || shot.beat}</span>
                        {cardState.job?.progress > 0 && (
                          <span className="phone-progress">
                            <span style={{ width: `${Math.min(100, Math.max(0, cardState.job.progress || 0))}%` }} />
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
              {selectedShotRow && (
                <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-sf-text-primary">Shot {selectedShotIndex + 1}: {selectedShotRow.shot.id}</div>
                      <div className="text-[10px] text-sf-text-muted">{selectedShotRow.scene.id}</div>
                    </div>
                    <span className="rounded-full border border-sf-dark-600 px-2 py-1 text-[10px] text-sf-text-muted">
                      {selectedKeyframeWorkflow.label} keyframe
                    </span>
                  </div>
                  <label className="mt-3 block text-xs text-sf-text-secondary">
                    <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Edit shot keyframe prompt</span>
                    <textarea
                      value={selectedShotRow.shot.imageBeat || selectedShotRow.shot.beat || ''}
                      onChange={(e) => handleYoloShotImageBeatChange(selectedShotRow.scene.id, selectedShotRow.shot.id, e.target.value)}
                      rows={4}
                      className="mt-1 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
                    />
                  </label>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button type="button" disabled={isQueuingKeyframes || yoloDependencyCheckInProgress || keyframeReferenceMissing || customKeyframeNeedsSetup} onClick={() => { setKeyframeStatus(`Queued ${selectedKeyframeWorkflow.label} keyframe regeneration for Shot ${selectedShotIndex + 1}.`); void handleQueueYoloShotStoryboard(selectedShotRow.scene.id, selectedShotRow.shot.id, { resolutionOverride: outputResolution, ...getKeyframeReferenceOverrides(), storyboardReferenceAssetIdsOverride: getKeyframeReferenceAssetIds(), storyboardWorkflowIdOverride: selectedKeyframeWorkflow.workflowId }) }} className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-50">Generate Selected Keyframe</button>
                    <button type="button" disabled={isQueuingKeyframes || yoloDependencyCheckInProgress || planShots.length === 0 || keyframeReferenceMissing || customKeyframeNeedsSetup} onClick={handleRegenerateAllKeyframes} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50">Regenerate All</button>
                    <button type="button" onClick={() => { setYoloTakesPerAngle(3); handleYoloShotTakesChange(selectedShotRow.scene.id, selectedShotRow.shot.id, 3); setKeyframeStatus('Variation mode set to 3 takes. Click regenerate to queue three seed variations for the selected shot.') }} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Make 3 Variations</button>
                    <span className="text-[10px] text-sf-text-muted">{keyframeStatus}</span>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => setStep('script')} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Back</button>
                <div className="flex gap-2">
                  <button type="button" disabled={yoloStoryboardReadyCount === 0} onClick={() => setStep('videos')} className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
                    Next: Videos + Timeline
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {step === 'videos' && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-4">
          <div>
            <div className="ugc-kicker">Clips + Cut</div>
            <h2 className="mt-1 text-lg font-semibold text-sf-text-primary">
              {videoGeneratingCount > 0
                ? 'Generating shot videos.'
                : 'Generate videos, then assemble the timeline.'}
            </h2>
            <p className="mt-1 text-xs text-sf-text-muted">Each keyframe becomes a clip. Select one to edit only its motion prompt. When the clips are ready, assemble them into the editor in shot order.</p>
          </div>
          <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/40 px-3 py-2 text-xs text-sf-text-secondary">
            {planShots.length} shots / {commercialLength}s / {selectedKeyframeWorkflow.label} keyframes / {selectedVideoWorkflow.label} video
          </div>
          <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="ugc-card-title">Video model pass</div>
                <div className="mt-1 text-sm font-semibold text-sf-text-primary">Viewing {selectedVideoWorkflow.label}</div>
                <p className="mt-1 text-xs text-sf-text-muted">Use the same keyframes to create another complete model pass for comparison in editing.</p>
              </div>
              <span className="rounded-full border border-sf-dark-600 px-2 py-1 text-[10px] text-sf-text-muted">{outputResolutionLabel} / {videoFps} fps</span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {VIDEO_MODEL_OPTIONS.map((option) => renderChoiceButton(videoWorkflowId === option.id, option.label, () => handleVideoWorkflowChange(option.id), option.helper))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!handleAssembleAdTimeline || videoReadyCount === 0 || yoloActivePlanIsStale || isAssemblingTimeline}
                onClick={handleAssembleTimeline}
                title={videoReadyCount === 0 ? 'Generate at least one ready video first.' : 'Place the ready ad videos on a timeline track using the shot order and durations.'}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isAssemblingTimeline ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
                Assemble Timeline
              </button>
              <button type="button" disabled={isQueuingVideos || yoloDependencyCheckInProgress || yoloStoryboardReadyCount === 0} onClick={handleRegenerateAllVideos} className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
                {isQueuingVideos ? `Queueing ${selectedVideoWorkflow.label}...` : `Generate All With ${selectedVideoWorkflow.label}`}
              </button>
              <span className="text-[10px] text-sf-text-muted">{videoStatus}</span>
            </div>
            {timelineStatus && (
              <div className={`mt-3 rounded-lg border p-3 text-xs ${
                timelineStatusOk
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
                  : 'border-yellow-500/40 bg-yellow-500/10 text-yellow-100'
              }`}>
                {timelineStatus}
              </div>
            )}
          </div>
          <div className="phone-grid">
            {planShots.map(({ scene, shot }, index) => {
              const variant = getFirstVariantForShot(scene.id, shot.id)
              const asset = getVideoAssetForVariant(variant)
              const url = getAssetUrl(asset)
              const hasKeyframe = variant ? yoloStoryboardAssetMap?.has(variant.key) : false
              const cardState = getVideoCardState(variant, asset, hasKeyframe)
              const statusClass = cardState.state === 'ready'
                ? 'ready'
                : cardState.state === 'generating'
                  ? 'generating'
                  : cardState.state === 'error'
                    ? 'error'
                    : cardState.state === 'blocked'
                      ? 'blocked'
                      : 'pending'
              const fillClass = cardState.state === 'ready'
                ? `ready-${(index % 3) + 1}`
                : cardState.state === 'generating'
                  ? 'generating'
                  : ''
              return (
                <button
                  key={`easy-video-${scene.id}-${shot.id}`}
                  type="button"
                  onClick={() => setSelectedVideoIndex(index)}
                  className={`phone-card ${selectedVideoIndex === index ? 'selected' : ''}`}
                >
                  <span className="phone-shell">
                    <span className="notch" />
                    {url ? (
                      <video
                        src={url}
                        className="absolute inset-0 h-full w-full object-contain bg-black"
                        muted
                        autoPlay
                        loop
                        playsInline
                        preload="metadata"
                      />
                    ) : (
                      <>
                        {cardState.state === 'generating' && (
                          <span className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                        )}
                        <span className={`phone-fill ${fillClass}`}>
                          {cardState.label}
                        </span>
                      </>
                    )}
                    <span className={`phone-status ${statusClass}`}>{cardState.label}</span>
                  </span>
                  <span className="phone-meta">
                    <span className="shot-name">{index + 1} - {shot.id}</span>
                    <span className="shot-line">{shot.videoBeat || shot.beat || cardState.label}</span>
                    {cardState.job?.progress > 0 && (
                      <span className="phone-progress">
                        <span style={{ width: `${Math.min(100, Math.max(0, cardState.job.progress || 0))}%` }} />
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
          {selectedVideoRow && (
            <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-sf-text-primary">Shot {selectedVideoIndex + 1} Video: {selectedVideoRow.shot.id}</div>
                  <div className="text-[10px] text-sf-text-muted">{selectedVideoRow.scene.id}</div>
                </div>
                <span className="rounded-full border border-sf-dark-600 px-2 py-1 text-[10px] text-sf-text-muted">{selectedVideoWorkflow.label}</span>
              </div>
              <label className="mt-3 block text-xs text-sf-text-secondary">
                <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Edit shot motion prompt</span>
                <textarea
                  value={selectedVideoRow.shot.videoBeat || selectedVideoRow.shot.beat || ''}
                  onChange={(e) => handleYoloShotVideoBeatChange(selectedVideoRow.scene.id, selectedVideoRow.shot.id, e.target.value)}
                  rows={4}
                  className="mt-1 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
                />
              </label>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" disabled={isQueuingVideos || yoloDependencyCheckInProgress} onClick={() => { setVideoStatus(`Queued ${selectedVideoWorkflow.label} video regeneration for Shot ${selectedVideoIndex + 1}.`); void handleQueueYoloShotVideo(selectedVideoRow.scene.id, selectedVideoRow.shot.id, { planOverride: yoloActivePlan, skipStaleCheck: true, targetWorkflowIds: [videoWorkflowId], resolutionOverride: outputResolution, videoReferenceAssetIds: getVideoReferenceAssetIds() }) }} className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-50">Regenerate Shot With {selectedVideoWorkflow.label}</button>
                <button type="button" onClick={() => { setYoloTakesPerAngle(3); handleYoloShotTakesChange(selectedVideoRow.scene.id, selectedVideoRow.shot.id, 3); setVideoStatus('Variation mode set to 3 takes. Click regenerate to queue three video seed variations after keyframes exist.') }} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Make 3 Variations</button>
                <span className="text-[10px] text-sf-text-muted">{videoStatus}</span>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => setStep('keyframes')} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Back</button>
            <button type="button" onClick={() => setStep('setup')} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Start Another Ad</button>
          </div>
        </div>
      )}
        </section>
        {renderSideRail()}
      </div>
    </div>
  )
}
