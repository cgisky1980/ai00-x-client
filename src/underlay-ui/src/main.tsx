import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import "../app.css";
import { UnderlayDesktopProvider } from "@underlay/desktop/UnderlayDesktopContext";
import { GridDesktop } from "@underlay/components/GridDesktop";
import "gridstack/dist/gridstack.min.css";
import { MicroGardenLayer } from "@underlay/components/MicroGardenLayer";
import { GardenToolbar } from "@underlay/components/GardenToolbar";
import { listen } from "@tauri-apps/api/event";
import { BackgroundProvider, DynamicBackground } from "@underlay/components/DynamicBackground";

/**
 * 派发鼠标事件到 window，触发 window 级 capture 监听器（如花盆拖动/点击）。
 * 用于 Tauri raw mouse 注入：当点击落在背景 iframe 或桌面空白区域时，
 * 正常 DOM 事件不会到达 window，需要手动派发。
 */
function dispatchToWindow(
  type: string,
  x: number,
  y: number,
  button: number,
  buttons: number,
  deltaY: number,
): void {
  const opts: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    buttons: buttons,
    button: button,
  };
  if (type === "wheel") {
    window.dispatchEvent(new WheelEvent("wheel", {
      ...opts,
      deltaX: 0,
      deltaY: deltaY || 0,
    } as WheelEventInit));
  } else {
    window.dispatchEvent(new MouseEvent(type, opts));
  }
}

/**
 * Hook to listen for raw mouse events from the Rust backend (Windows only).
 * When the underlay is embedded in the desktop layer, normal mouse events
 * don't reach the WebView. The backend uses RegisterRawInputDevices to
 * capture mouse input and forwards it via the "underlay_raw_mouse" event.
 * This hook injects those events into the DOM.
 */
function useRawMouseInjection() {
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<{
      type: string;
      x: number;
      y: number;
      button: number;
      buttons: number;
      deltaY: number;
    }>("underlay_raw_mouse", (event) => {
      const { type, x, y, button, buttons, deltaY } = event.payload;

      const els = document.elementsFromPoint(x, y);

      // Forward mouse events to wallpaper iframe (for interactive wallpapers)
      const bgFrame = els.find(
        (e) => e.tagName === "IFRAME" && (e as HTMLIFrameElement).title === "background"
      ) as HTMLIFrameElement | undefined;
      if (bgFrame) {
        const rect = bgFrame.getBoundingClientRect();
        bgFrame.contentWindow?.postMessage({
          type: "ai00-mouse",
          x: x - rect.left,
          y: y - rect.top,
          buttons,
          button,
          deltaY,
          eventType: type,
        }, "*");
        // 背景壁纸 iframe 跨域，dispatchEvent 到 iframe 不会冒泡到 parent window。
        // 因此这里也派发到 window，让 window 级捕获监听器（如花盆拖动/点击）能收到事件。
        dispatchToWindow(type, x, y, button, buttons, deltaY);
        return;
      }

      const el = els.find(
        (e) => getComputedStyle(e).pointerEvents !== "none"
      );
      if (!el || el.tagName === "HTML" || el.tagName === "BODY" || el.id === "root") {
        // 点击的是桌面空白区域（所有元素 pointerEvents:none 或仅 HTML/BODY/root）
        // 派发所有鼠标事件到 window，以触发 window 级 capture 监听器（如花盆拖动/点击）
        dispatchToWindow(type, x, y, button, buttons, deltaY);
        return;
      }

      if (type === "wheel") {
        const opts: WheelEventInit = {
          bubbles: true,
          cancelable: true,
          deltaX: 0,
          deltaY: deltaY || 0,
          clientX: x,
          clientY: y,
        };
        el.dispatchEvent(new WheelEvent("wheel", opts));
      } else {
        const opts: MouseEventInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          buttons: buttons,
          button: button,
        };

        if (type === "click") {
          el.dispatchEvent(new MouseEvent("click", opts));
        } else {
          // Map mouse events to pointer events
          let ptrType = type;
          if (type === "mousedown") ptrType = "pointerdown";
          else if (type === "mouseup") ptrType = "pointerup";
          else if (type === "mousemove") ptrType = "pointermove";

          el.dispatchEvent(
            new PointerEvent(ptrType, {
              ...opts,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
            } as PointerEventInit)
          );
          el.dispatchEvent(new MouseEvent(type, opts));
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      try {
        unlisten?.();
      } catch {}
    };
  }, []);
}

function UnderlayApp() {
  useRawMouseInjection();

  return (
    <BackgroundProvider>
      <DynamicBackground />
      <UnderlayDesktopProvider>
        <MicroGardenLayer>
          <div className="h-full w-full relative bg-transparent" style={{ pointerEvents: 'none' }}>
            <GridDesktop />
          </div>
          <GardenToolbar />
        </MicroGardenLayer>
      </UnderlayDesktopProvider>
    </BackgroundProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UnderlayApp />
  </React.StrictMode>
);
