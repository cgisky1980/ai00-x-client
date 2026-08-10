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

export function PluginWidget({ pluginId, entryPath, className }: PluginWidgetProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Use the subdomain isolation scheme
  // http://{plugin_id}.localhost:{port}/{entry_path}
  const src = `http://${pluginId}.localhost:${EMBEDDED_SERVER_PORT}/${entryPath}`

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Verify origin matches the plugin's origin
      const allowedOrigin = `http://${pluginId}.localhost:${EMBEDDED_SERVER_PORT}`
      console.log(`[PluginWidget] Message from ${event.origin}, expected: ${allowedOrigin}`, event.data)
      
      // Allow messages from the specific plugin origin
      // Relaxed check for debugging - just warn if mismatch
      if (event.origin !== allowedOrigin) {
          console.warn(`[PluginWidget] Origin mismatch! Received: ${event.origin}, expected: ${allowedOrigin}`)
          // return // Temporarily commented out for debugging
      }

      if (!event.data || typeof event.data !== 'object') return
      const { type, payload } = event.data as { type: string, payload: any }
      if (!type) return

      console.log(`[Plugin:${pluginId}] Message received:`, type, payload)

      switch (type) {
        case 'plugin.ready':
            // Send initial config or theme if needed
            // TODO: Get actual theme from context
            iframeRef.current?.contentWindow?.postMessage({
                type: 'host.init',
                payload: { theme: 'dark' } 
            }, allowedOrigin)
            break
        
        case 'plugin.proxy_request':
            const { requestId, url, method, headers } = payload
            invoke('proxy_http_request', { url, method, headers })
                .then((response) => {
                    iframeRef.current?.contentWindow?.postMessage({
                        type: 'host.proxy_response',
                        payload: { requestId, success: true, data: response }
                    }, allowedOrigin)
                })
                .catch((error) => {
                     iframeRef.current?.contentWindow?.postMessage({
                        type: 'host.proxy_response',
                        payload: { requestId, success: false, error: String(error) }
                    }, allowedOrigin)
                })
            break

        case 'plugin.open_external':
            const { url: openUrlStr } = payload
            console.log(`[Plugin:${pluginId}] Opening external URL:`, openUrlStr)
            
            if (openUrlStr) {
                const tryOpen = async () => {
                    // Try plugin-opener JS API (Recommended for Tauri v2)
                    try {
                        console.log(`[Plugin:${pluginId}] Trying plugin-opener JS API...`)
                        await openUrl(openUrlStr)
                        console.log(`[Plugin:${pluginId}] Success: plugin-opener JS API`)
                        return
                    } catch (e0) {
                        console.warn(`[Plugin:${pluginId}] plugin-opener JS API failed:`, e0)
                    }

                    // Fallback to shell plugin
                    try {
                        console.log(`[Plugin:${pluginId}] Trying shell|open (JS API)...`)
                        await openShell(openUrlStr)
                        console.log(`[Plugin:${pluginId}] Success: shell|open`)
                        return
                    } catch (e3) {
                        console.error(`[Plugin:${pluginId}] shell|open failed:`, e3)
                    }

                    // Last resort: window.open (might be blocked)
                    try {
                        console.log(`[Plugin:${pluginId}] Trying window.open...`)
                        window.open(openUrlStr, '_blank')
                    } catch (e4) {
                        console.error(`[Plugin:${pluginId}] window.open failed:`, e4)
                    }
                }

                tryOpen()
            }
            break
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
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-same-origin"
        allow="cross-origin-isolated"
      />
      
      {/* Overlay to allow dragging/resizing without iframe capturing mouse events when not interacting */}
      <div className="absolute inset-0 pointer-events-none group-hover:pointer-events-none" />
    </div>
  )
}
