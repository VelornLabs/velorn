/**
 * LM Studio API Service
 * Handles communication with LM Studio local LLM server
 * 
 * LM Studio runs on localhost:1234 by default
 * API documentation: https://lmstudio.ai/docs/developer/rest
 */

const isDev = import.meta.env.DEV
const LMSTUDIO_BASE = isDev ? 'http://localhost:1234' : 'http://localhost:1234'

class LMStudioService {
  constructor() {
    this.baseUrl = LMSTUDIO_BASE
    this.apiToken = null // LM Studio may use API tokens, but often works without
  }

  /**
   * Set API token (optional, LM Studio may work without)
   */
  setApiToken(token) {
    this.apiToken = token
  }

  setBaseUrl(url) {
    const nextUrl = String(url || '').trim().replace(/\/+$/, '')
    this.baseUrl = nextUrl || LMSTUDIO_BASE
  }

  getBaseUrl() {
    return this.baseUrl
  }

  /**
   * Get headers for API requests
   */
  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    }
    if (this.apiToken) {
      headers['Authorization'] = `Bearer ${this.apiToken}`
    }
    return headers
  }

  /**
   * Check if LM Studio server is running
   */
  async checkConnection() {
    try {
      // Try v1 first, fallback to v0 for compatibility
      const response = await fetch(`${this.baseUrl}/api/v1/models/list`, {
        method: 'GET',
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        // Try v0 endpoint as fallback
        const v0Response = await fetch(`${this.baseUrl}/api/v0/models`, {
          method: 'GET',
          headers: this.getHeaders(),
        })
        if (v0Response.ok) return true

        const openAiResponse = await fetch(`${this.baseUrl}/v1/models`, {
          method: 'GET',
          headers: this.getHeaders(),
        })
        return openAiResponse.ok
      }
      return response.ok
    } catch (error) {
      return false
    }
  }

  /**
   * List all available models (both loaded and unloaded)
   */
  async listModels() {
    try {
      // Try v1 first
      let response = await fetch(`${this.baseUrl}/api/v1/models/list`, {
        method: 'GET',
        headers: this.getHeaders(),
      })
      
      // Fallback to v0 if v1 fails
      if (!response.ok) {
        response = await fetch(`${this.baseUrl}/api/v0/models`, {
          method: 'GET',
          headers: this.getHeaders(),
        })
      }

      if (!response.ok) {
        response = await fetch(`${this.baseUrl}/v1/models`, {
          method: 'GET',
          headers: this.getHeaders(),
        })
      }
      
      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.statusText}`)
      }
      
      const data = await response.json()
      // LM Studio and OpenAI-compatible endpoints return { data: [...] };
      // older endpoints may return the array directly.
      const models = data.data || data || []
      return Array.isArray(models) ? models : []
    } catch (error) {
      console.error('Error listing models:', error)
      throw error
    }
  }

  /**
   * Load a model into memory
   * @param {string} modelId - Model identifier
   * @param {object} options - Load options (context_length, flash_attention, etc.)
   */
  async loadModel(modelId, options = {}) {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/models/load`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: modelId,
          ...options,
        }),
      })
      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Failed to load model: ${errorText}`)
      }
      const data = await response.json()
      return data
    } catch (error) {
      console.error('Error loading model:', error)
      throw error
    }
  }

  /**
   * Unload a model from memory
   * Tries v1 POST first; if server doesn't support it (e.g. LM Studio < 0.4.0), throws a helpful error.
   * @param {string} instanceId - Model instance ID (usually same as model ID)
   */
  async unloadModel(instanceId) {
    const tryUnload = async (url, options) => {
      const response = await fetch(url, options)
      if (!response.ok) {
        const errorText = await response.text()
        return { ok: false, errorText }
      }
      try {
        return { ok: true, data: await response.json() }
      } catch {
        return { ok: true, data: {} }
      }
    }

    try {
      // LM Studio 0.4.0+ v1 API
      let result = await tryUnload(`${this.baseUrl}/api/v1/models/unload`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ instance_id: instanceId }),
      })
      if (result.ok) return result.data

      const isUnsupported = result.errorText && (
        result.errorText.includes('Unexpected endpoint or method') ||
        result.errorText.includes('404') ||
        result.errorText.includes('Not Found')
      )
      if (isUnsupported) {
        throw new Error(
          'Unload is not supported by your LM Studio version. Please update LM Studio to 0.4.0 or later (Settings → check for updates), or unload the model from the LM Studio app.'
        )
      }
      throw new Error(`Failed to unload model: ${result.errorText}`)
    } catch (error) {
      console.error('Error unloading model:', error)
      throw error
    }
  }

  /**
   * Send a chat completion request
   * Uses OpenAI-compatible endpoint for better compatibility
   * @param {string} modelId - Model identifier
   * @param {Array} messages - Array of {role, content} messages
   * @param {object} options - Generation options (temperature, max_tokens, etc.)
   */
  async chatCompletion(modelId, messages, options = {}) {
    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: modelId,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.max_tokens ?? -1, // -1 means no limit
          stream: options.stream ?? false,
          ...options,
        }),
      })
      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Chat completion failed: ${errorText}`)
      }
      const data = await response.json()
      return data
    } catch (error) {
      console.error('Error in chat completion:', error)
      throw error
    }
  }

  /**
   * Stream chat completion (for real-time responses)
   * @param {string} modelId - Model identifier
   * @param {Array} messages - Array of {role, content} messages
   * @param {Function} onChunk - Callback for each chunk
   * @param {object} options - Generation options
   */
  async streamChatCompletion(modelId, messages, onChunk, options = {}) {
    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: modelId,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.max_tokens ?? -1,
          stream: true,
          ...options,
        }),
      })
      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Stream chat completion failed: ${errorText}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value)
        const lines = chunk.split('\n').filter(line => line.trim() !== '')

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') {
              return
            }
            try {
              const json = JSON.parse(data)
              if (json.choices?.[0]?.delta?.content) {
                onChunk(json.choices[0].delta.content)
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (error) {
      console.error('Error in stream chat completion:', error)
      throw error
    }
  }
}

// Export singleton instance
const lmstudio = new LMStudioService()
export default lmstudio
