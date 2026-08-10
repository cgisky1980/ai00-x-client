//! RAII guards for Win32 GDI / icon handles.
//!
//! Each guard owns a handle and releases it on `Drop`. Constructors return
//! `Option<Self>` — `None` when the handle is invalid (zero / null), so
//! callers can short-circuit without leaking. Mirrors Patina's
//! `platform/windows/handles.rs`.

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{DeleteDC, DeleteObject, ReleaseDC, HBITMAP, HDC};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, HICON};

/// Owns an `HICON` and calls `DestroyIcon` on drop.
pub struct OwnedIcon {
    raw: HICON,
}

impl OwnedIcon {
    /// Wrap a handle. Returns `None` when the handle is invalid.
    pub fn new(raw: HICON) -> Option<Self> {
        if raw.is_invalid() {
            None
        } else {
            Some(Self { raw })
        }
    }

    /// Borrow the underlying handle.
    pub fn raw(&self) -> HICON {
        self.raw
    }
}

impl Drop for OwnedIcon {
    fn drop(&mut self) {
        // SAFETY: we own the icon and no one else holds a reference to it.
        unsafe {
            let _ = DestroyIcon(self.raw);
        }
    }
}

/// Owns an `HBITMAP` and calls `DeleteObject` on drop.
pub struct OwnedBitmap {
    raw: HBITMAP,
}

impl OwnedBitmap {
    /// Wrap a handle. Returns `None` when the handle is invalid.
    pub fn new(raw: HBITMAP) -> Option<Self> {
        if raw.is_invalid() {
            None
        } else {
            Some(Self { raw })
        }
    }

    /// Borrow the underlying handle.
    pub fn raw(&self) -> HBITMAP {
        self.raw
    }
}

impl Drop for OwnedBitmap {
    fn drop(&mut self) {
        // SAFETY: we own the bitmap and no one else holds a reference to it.
        unsafe {
            let _ = DeleteObject(self.raw.into());
        }
    }
}

/// Owns a screen DC obtained via `GetDC` and calls `ReleaseDC` on drop.
/// Stores the `hwnd` used with `GetDC` so it can be passed back to `ReleaseDC`.
pub struct ScreenDcGuard {
    hwnd: Option<HWND>,
    dc: HDC,
}

impl ScreenDcGuard {
    /// Wrap a DC. Returns `None` when the DC handle is invalid.
    pub fn new(hwnd: Option<HWND>, dc: HDC) -> Option<Self> {
        if dc.is_invalid() {
            None
        } else {
            Some(Self { hwnd, dc })
        }
    }

    /// Borrow the underlying DC handle.
    pub fn raw(&self) -> HDC {
        self.dc
    }
}

impl Drop for ScreenDcGuard {
    fn drop(&mut self) {
        // SAFETY: we own the DC lease for this hwnd; ReleaseDC pairs with GetDC.
        unsafe {
            let _ = ReleaseDC(self.hwnd, self.dc);
        }
    }
}

/// Owns a memory DC obtained via `CreateCompatibleDC` and calls `DeleteDC`
/// on drop.
pub struct MemoryDcGuard {
    dc: HDC,
}

impl MemoryDcGuard {
    /// Wrap a memory DC. Returns `None` when the handle is invalid.
    pub fn new(dc: HDC) -> Option<Self> {
        if dc.is_invalid() {
            None
        } else {
            Some(Self { dc })
        }
    }

    /// Borrow the underlying DC handle.
    pub fn raw(&self) -> HDC {
        self.dc
    }
}

impl Drop for MemoryDcGuard {
    fn drop(&mut self) {
        // SAFETY: we own the memory DC; DeleteDC pairs with CreateCompatibleDC.
        unsafe {
            let _ = DeleteDC(self.dc);
        }
    }
}
