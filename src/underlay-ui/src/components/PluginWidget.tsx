import { useEffect, useRef } from "react"
import { cn } from "@underlay/lib/utils"
import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"
import { open as openShell } from "@tauri-apps/plugin-shell"
import { EMBEDDED_SERVER_PORT } from "@ai00-x/shared"

interface PluginWidgetProps {
  pluginId: string
  entryPath: string
  className?: string
}

/**
 * Hosts a sandboxed iframe plugin widget.
 *
 * The iframe is served from the embedded server via path routing
 * (`/plugins/{id}/{path}`) and sandboxed WITHOUT `allow-same-origin`, so the
 * plugin gets an opaque origin (`event.origin === "null"`) and cannot touch
 * host storage/cookies. Messages are validated by matching
 * `event.source === iframe.contentWindow`.
 */
export function PluginWidget({ pluginId, entryPath, className }: PluginWidgetProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const src = `http://127.0.0.1:${EMBEDDED_SERVER_PORT}/plugins/${pluginId}/${entryPath.replace(/^\/+/, "")}`

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Sandboxed iframe (no allow-same-origin) has opaque origin "null";
      // authenticity is guaranteed by matching the source window.
      if (event.origin !== "null") return
      if (event.source !== iframeRef.current?.contentWindow) return

      if (!event.data || typeof event.data !== "object") return
      const { type, payload } = event.data as { type: string; payload: any }
      if (!type) return

      // Opaque origin: target origin must be "*"
      const post = (msg: unknown) =>
        iframeRef.current?.contentWindow?.postMessage(msg, "*")

      switch (type) {
        case 'plugin.ready':
          // Send initial config or theme if needed
          post({
            type: 'host.init',
            payload: { theme: 'dark' }
          })
          break

        case 'plugin.proxy_request': {
          const { requestId, url, method, headers } = payload
          invoke('proxy_http_request', { url, method, headers })
            .then((response) => {
              post({
                type: 'host.proxy_response',
                payload: { requestId, success: true, data: response }
              })
            })
            .catch((error) => {
              post({
                type: 'host.proxy_response',
                payload: { requestId, success: false, error: String(error) }
              })
            })
          break
        }

        case 'plugin.open_external': {
          const { url: openUrlStr } = payload
          if (!openUrlStr) break

          const tryOpen = async () => {
            // Try plugin-opener JS API (Recommended for Tauri v2)
            try {
              await openUrl(openUrlStr)
              return
            } catch (e0) {
              console.warn(`[Plugin:${pluginId}] plugin-opener failed:`, e0)
            }
            // Fallback to shell plugin
            try {
              await openShell(openUrlStr)
              return
            } catch (e3) {
              console.warn(`[Plugin:${pluginId}] shell|open failed:`, e3)
            }
            // Last resort: window.open (might be blocked)
            try {
              window.open(openUrlStr, '_blank')
            } catch (e4) {
              console.warn(`[Plugin:${pluginId}] window.open failed:`, e4)
            }
          }

          tryOpen()
          break
        }

        case 'plugin.storage_request': {
          // Unified plugin data storage access. The host fills pluginId
          // (sandboxed plugins cannot impersonate other plugins' data).
          const { requestId, op, key, value } = payload ?? {}
          const respond = (result: Record<string, unknown>) =>
            post({ type: 'host.storage_response', payload: { requestId, ...result } })

          const run = async () => {
            switch (op) {
              case 'get':
                respond({ success: true, data: await invoke('plugin_data_get', { pluginId, key }) })
                break
              case 'set':
                await invoke('plugin_data_set', { pluginId, key, value })
                respond({ success: true })
                break
              case 'remove':
                await invoke('plugin_data_remove', { pluginId, key })
                respond({ success: true })
                break
              case 'keys':
                respond({ success: true, data: await invoke('plugin_data_keys', { pluginId }) })
                break
              case 'clear':
                await invoke('plugin_data_clear', { pluginId })
                respond({ success: true })
                break
              default:
                respond({ success: false, error: `unsupported op: ${op}` })
            }
          }
          run().catch((error) => respond({ success: false, error: String(error) }))
          break
        }
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [pluginId])

  return (
    <div className={cn("w-full h-full bg-background/80 backdrop-blur-sm rounded-xl overflow-hidden border border-border/50 shadow-sm group", className)}>
      <iframe
        ref={iframeRef}
        src={src}
        className="w-full h-full border-0 pointer-events-auto"
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
      />

      {/* Overlay to allow dragging/resizing without iframe capturing mouse events when not interacting */}
      <div className="absolute inset-0 pointer-events-none group-hover:pointer-events-none" />
    </div>
  )
}
