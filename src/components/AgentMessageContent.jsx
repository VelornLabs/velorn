import { memo, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { presentAgentText } from '../utils/connectedAgentPresentation.mjs'
import { sanitizeConnectedAgentSourceUrl } from '../utils/connectedAgentContext.mjs'
import { copyTextToClipboard } from '../utils/textClipboard.mjs'

export function AgentCopyButton({ text, label = 'Copy response' }) {
  const [state, setState] = useState('idle')
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => { setState('idle'); clearTimeout(timer.current) }, [text])
  return <span className="ca-copy-control" data-ca-copy-exclude>
    <button type="button" aria-label={label} title={label} onClick={async () => {
      clearTimeout(timer.current)
      try { await copyTextToClipboard(text); setState('copied') } catch { setState('failed') }
      timer.current = setTimeout(() => setState('idle'), 3000)
    }}>{state === 'copied' ? <Check size={12} /> : <Copy size={12} />}{state === 'copied' ? 'Copied' : 'Copy'}</button>
    <span className={state === 'failed' ? 'ca-copy-error' : 'ca-copy-status'} role="status">{state === 'failed' ? 'Could not copy. Select the text and use Ctrl/Cmd+C.' : state === 'copied' ? 'Copied to clipboard' : ''}</span>
  </span>
}

function nodeText(node) {
  return typeof node?.value === 'string' ? node.value : (node?.children || []).map(nodeText).join('')
}
function CodeBlock({ children, node }) {
  const code = node?.children?.find(child => child.tagName === 'code')
  const language = (code?.properties?.className || []).find(value => value.startsWith('language-'))?.slice(9) || 'Text'
  return <div className="ca-code-block"><div className="ca-code-heading"><span>{language}</span>
    <AgentCopyButton text={nodeText(node).replace(/\n$/, '')} label="Copy code" /></div><pre>{children}</pre></div>
}
function AgentLink({ href, children }) {
  const [failed, setFailed] = useState(false)
  const safe = sanitizeConnectedAgentSourceUrl(href)
  if (!safe) return <span>{children}</span>
  return <><a className="ca-source-reference" href={safe} target="_blank" rel="noopener noreferrer" title={safe}
    onClick={async event => {
      // Never navigate the editor or launch on render. Native desktop uses the
      // existing external-browser bridge; web previews use a normal safe link.
      if (!window.electronAPI?.openExternalUrl) return
      event.preventDefault()
      setFailed(false)
      try {
        const result = await window.electronAPI.openExternalUrl(safe)
        if (!result?.success) setFailed(true)
      } catch { setFailed(true) }
    }}>{children}</a>{failed && <span role="status"> Could not open this link. Copy it instead: {safe}</span>}</>
}
// No raw HTML plugin, images, embeds, relative/file links, network fetches or
// interactive task controls. Public sources open only on a user click.
const components = {
  a: AgentLink,
  pre: CodeBlock,
  img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
  input: ({ checked }) => <span aria-label={checked ? 'Checked' : 'Unchecked'}>{checked ? '☑' : '☐'} </span>,
  table: ({ children }) => <div className="ca-table-scroll"><table>{children}</table></div>,
}
const plugins = [remarkGfm]
function ReadableText({ text }) {
  return <Markdown remarkPlugins={plugins} components={components} urlTransform={url => sanitizeConnectedAgentSourceUrl(url) || ''}>{text}</Markdown>
}

export const AgentMessageContent = memo(function AgentMessageContent({ text, progress = false, copyable = false, actions = null }) {
  const presentation = presentAgentText(text, { progress })
  return <div className="ca-message-content">
    <div className="ca-markdown">{presentation.json
      ? <div className="ca-code-block"><div className="ca-code-heading"><span>JSON</span><AgentCopyButton text={presentation.source} label="Copy JSON" /></div><pre><code>{presentation.source}</code></pre></div>
      : <ReadableText text={presentation.markdown} />}</div>
    {presentation.adapted && !progress && <details className="ca-original-response"><summary>Original response</summary><pre>{presentation.source}</pre><AgentCopyButton text={presentation.source} label="Copy original response" /></details>}
    {(copyable || actions) && <div className="ca-message-actions">{copyable && <AgentCopyButton text={presentation.markdown} />}{actions}</div>}
  </div>
})
