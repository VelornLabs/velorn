import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Coins, AlertTriangle, Loader2 } from 'lucide-react'
import {
  getComfyPartnerApiKey,
  COMFY_PARTNER_KEY_CHANGED_EVENT,
  COMFY_PARTNER_CREDITS_LOW_EVENT,
} from '../services/comfyPartnerAuth'
import { comfyui } from '../services/comfyui'
import {
  CLOUD_CREDIT_DISPLAY_CHANGED_EVENT,
  getShowCloudCreditBalance,
} from '../services/cloudCreditDisplaySettings'

/**
 * CreditsChip
 *
 * A compact status pill that surfaces the user's Comfy.org credit balance.
 *
 * Behaviour:
 *   - In Electron, the chip can read the logged-in embedded ComfyUI session
 *     through the main-process bridge and display the same balance shown in
 *     ComfyUI's Settings > Credits panel.
 *   - In browser mode, or as a fallback, it still supports the older stored
 *     Comfy Partner API key path via `comfyui.getComfyOrgCreditBalance()`.
 *   - A failed queue submission anywhere in the app can dispatch the
 *     `COMFY_PARTNER_CREDITS_LOW_EVENT` and this chip flips into an amber
 *     "Out of credits" state immediately.
 */
function CreditsChip({ className = '', size = 'sm' }) {
  const [showCreditBalance, setShowCreditBalance] = useState(() => getShowCloudCreditBalance())
  const [hasKey, setHasKey] = useState(false)
  const [balance, setBalance] = useState({
    status: 'idle', // 'idle' | 'loading' | 'ok' | 'unknown' | 'low'
    credits: null,
  })
  const [isRefreshing, setIsRefreshing] = useState(false)
  const pollTimerRef = useRef(null)
  const mountedRef = useRef(true)
  const refreshInFlightRef = useRef(false)
  const hasEmbeddedBalanceSupport = typeof window !== 'undefined'
    && typeof window?.electronAPI?.getComfyCloudCreditBalance === 'function'

  useEffect(() => {
    const onDisplayChanged = (event) => {
      setShowCreditBalance(event?.detail?.show !== false)
    }
    window.addEventListener(CLOUD_CREDIT_DISPLAY_CHANGED_EVENT, onDisplayChanged)
    return () => window.removeEventListener(CLOUD_CREDIT_DISPLAY_CHANGED_EVENT, onDisplayChanged)
  }, [])

  const refreshBalance = useCallback(async () => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    if (mountedRef.current) setIsRefreshing(true)

    try {
      setBalance((prev) => {
        if (prev.status === 'low') return prev
        if (Number.isFinite(prev.credits)) return prev
        return { ...prev, status: 'loading' }
      })

      const embeddedLookup = typeof window !== 'undefined'
        ? window?.electronAPI?.getComfyCloudCreditBalance
        : null
      if (typeof embeddedLookup === 'function') {
        const embeddedResult = await embeddedLookup()
        if (!mountedRef.current) return
        if (embeddedResult?.status === 'ok' && Number.isFinite(embeddedResult.credits)) {
          setBalance({ status: 'ok', credits: embeddedResult.credits })
          return
        }
      }

      // No ComfyUI on this computer, or nobody signed in there: ask with the Comfy key
      // the person pasted in Create. The key stays in the main process; only the number comes back.
      const routerLookup = typeof window !== 'undefined' ? window?.electronAPI?.comfyRouter?.balance : null
      if (typeof routerLookup === 'function') {
        const routerResult = await routerLookup({}).catch(() => null)
        if (!mountedRef.current) return
        if (routerResult?.success && routerResult.known && Number.isFinite(routerResult.credits)) {
          setBalance({ status: 'ok', credits: routerResult.credits })
          return
        }
      }

      const key = await getComfyPartnerApiKey()
      if (!key) {
        if (!mountedRef.current) return
        setBalance((prev) => prev.status === 'low' || Number.isFinite(prev.credits)
          ? prev
          : { status: 'unknown', credits: null })
        return
      }

      const result = await comfyui.getComfyOrgCreditBalance()
      if (!mountedRef.current) return

      if (result?.status === 'ok' && Number.isFinite(result.credits)) {
        setBalance({ status: 'ok', credits: result.credits })
      } else {
        setBalance((prev) => prev.status === 'low' || Number.isFinite(prev.credits)
          ? prev
          : { status: 'unknown', credits: null })
      }
    } catch (_) {
      if (!mountedRef.current) return
      setBalance((prev) => prev.status === 'low' || Number.isFinite(prev.credits)
        ? prev
        : { status: 'unknown', credits: null })
    } finally {
      refreshInFlightRef.current = false
      if (mountedRef.current) setIsRefreshing(false)
    }
  }, [])

  // Track API-key presence for the legacy fallback; re-evaluate when the user
  // adds/removes a key.
  useEffect(() => {
    mountedRef.current = true
    let cancelled = false

    const load = async () => {
      const key = await getComfyPartnerApiKey()
      if (cancelled) return
      setHasKey(Boolean(key))
    }
    load()

    const onKeyChanged = () => { load() }
    window.addEventListener(COMFY_PARTNER_KEY_CHANGED_EVENT, onKeyChanged)

    return () => {
      cancelled = true
      mountedRef.current = false
      window.removeEventListener(COMFY_PARTNER_KEY_CHANGED_EVENT, onKeyChanged)
    }
  }, [])

  const handleRefresh = useCallback((e) => {
    e.preventDefault?.()
    e.stopPropagation?.()
    refreshBalance()
  }, [refreshBalance])

  // Poll when either balance source is available. The embedded ComfyUI source
  // gracefully returns "not-authenticated" until the user logs in.
  useEffect(() => {
    const canQueryBalance = showCreditBalance && (hasKey || hasEmbeddedBalanceSupport)

    if (!canQueryBalance) {
      setBalance({ status: 'idle', credits: null })
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
      return
    }

    refreshBalance()
    pollTimerRef.current = setInterval(refreshBalance, 2 * 60 * 1000)
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [hasKey, hasEmbeddedBalanceSupport, refreshBalance, showCreditBalance])

  // Flip into "low" state the moment any surface dispatches the event.
  useEffect(() => {
    const onLow = () => {
      setBalance({ status: 'low', credits: null })
    }
    window.addEventListener(COMFY_PARTNER_CREDITS_LOW_EVENT, onLow)
    return () => window.removeEventListener(COMFY_PARTNER_CREDITS_LOW_EVENT, onLow)
  }, [])

  const labelPieces = useMemo(() => {
    if (balance.status === 'low') {
      return {
        label: 'Comfy credits empty',
        tooltip: 'A recent job failed because your Comfy.org credit balance is exhausted.',
      }
    }
    if (balance.status === 'ok' && Number.isFinite(balance.credits)) {
      return {
        label: `${formatCreditCount(balance.credits)} Comfy credits`,
        tooltip: isRefreshing
          ? 'Refreshing your Comfy.org credit balance...'
          : 'Comfy.org generation credits — separate from Velo’s allowance. Click to refresh.',
      }
    }
    if (balance.status === 'loading') {
      return {
        label: 'Comfy credits',
        tooltip: 'Checking your Comfy.org credit balance...',
      }
    }
    return {
      label: 'Comfy credits',
      tooltip: 'Generation credits, not Velo’s allowance. Sign in through ComfyUI account settings to show the balance.',
    }
  }, [balance, isRefreshing])

  if (!showCreditBalance || (!hasKey && !hasEmbeddedBalanceSupport)) return null

  const isLow = balance.status === 'low'
  const isLive = balance.status === 'ok'
  const isLoading = balance.status === 'loading' || isRefreshing

  const sizeClasses = size === 'xs'
    ? 'h-6 px-2 text-[10.5px] gap-1'
    : 'h-7 px-2.5 text-[11px] gap-1.5'

  const iconSize = size === 'xs' ? 'w-3 h-3' : 'w-3.5 h-3.5'

  return (
    <button
      type="button"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={handleRefresh}
      aria-live="polite"
      title={labelPieces.tooltip}
      className={`no-drag flex items-center rounded-md font-medium border transition-colors ${sizeClasses} ${
        isLow
          ? 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/50 text-amber-100'
          : isLive
            ? 'bg-sf-dark-800 hover:bg-sf-dark-700 border-sf-dark-700 text-sf-text-primary'
            : 'bg-sf-dark-800 hover:bg-sf-dark-700 border-sf-dark-700 text-sf-text-secondary'
      } ${className}`}
    >
      {isLow ? (
        <AlertTriangle className={`${iconSize} text-amber-300 flex-shrink-0`} />
      ) : isLoading ? (
        <Loader2 className={`${iconSize} animate-spin flex-shrink-0`} />
      ) : (
        <Coins className={`${iconSize} flex-shrink-0 ${isLive ? 'text-amber-300' : 'text-sf-text-muted'}`} />
      )}
      <span className="whitespace-nowrap">{labelPieces.label}</span>
    </button>
  )
}

function formatCreditCount(n) {
  if (!Number.isFinite(n)) return '-'
  // Match the dashboard's display style: 3,004.00
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export default CreditsChip
