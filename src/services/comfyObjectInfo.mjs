function asStringList(values) {
  return Array.isArray(values)
    ? values.map((entry) => String(entry || '').trim()).filter(Boolean)
    : []
}

function choicesFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return asStringList(value.values || value.choices || value.options || value.enum)
}

/**
 * Read combo choices from the object_info shapes used by older and newer
 * ComfyUI releases and custom nodes.
 */
export function extractComboChoicesFromSpec(inputSpec) {
  if (!inputSpec) return []

  if (Array.isArray(inputSpec)) {
    const [typeOrChoices, config] = inputSpec
    if (Array.isArray(typeOrChoices)) return asStringList(typeOrChoices)

    const inlineChoices = choicesFromObject(typeOrChoices)
    if (inlineChoices.length > 0) return inlineChoices

    // Newer dynamic combos use ["COMBO", { options: [...] }].
    if (String(typeOrChoices || '').toUpperCase() === 'COMBO') {
      return choicesFromObject(config)
    }
  }

  return choicesFromObject(inputSpec)
}
