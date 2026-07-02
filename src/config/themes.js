export const THEME_STORAGE_KEY = 'comfystudio-theme'

export const THEMES = [
  {
    id: 'velorn',
    label: 'Velorn',
    description: 'Default brand theme with deep blues, violet, and readable old-gold accents',
    preview: { bg: '#030610', surface: '#11172a', accent: '#987000', text: '#f4eef8' },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Neutral dark grey inspired by DaVinci Resolve',
    preview: { bg: '#1a1a1a', surface: '#242424', accent: '#565C6B', text: '#e5e5e5' },
  },
  {
    id: 'soft-dark',
    label: 'Soft Dark',
    description: 'Softer contrast with a subtle cool-purple tint',
    preview: { bg: '#1c1c22', surface: '#26262e', accent: '#5a6282', text: '#dedee6' },
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    description: 'Maximum readability with vivid blue accent',
    preview: { bg: '#0a0a0c', surface: '#141418', accent: '#4090e0', text: '#ffffff' },
  },
  {
    id: 'arctic',
    label: 'Arctic',
    description: 'Cool blue-grey palette inspired by Nordic editors',
    preview: { bg: '#161a22', surface: '#1e242e', accent: '#5a90b8', text: '#dce4ec' },
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Warm dark tones with an amber accent',
    preview: { bg: '#1e1814', surface: '#2a221c', accent: '#a07040', text: '#e8e0d4' },
  },
]

export const DEFAULT_THEME_ID = 'velorn'

export function getStoredThemeId() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME_ID
  } catch {
    return DEFAULT_THEME_ID
  }
}

export function applyTheme(themeId) {
  const id = THEMES.find((t) => t.id === themeId) ? themeId : DEFAULT_THEME_ID
  if (id === DEFAULT_THEME_ID) {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', id)
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id)
  } catch {
    // storage unavailable
  }
}
