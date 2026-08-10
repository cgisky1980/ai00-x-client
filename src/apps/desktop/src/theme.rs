use ai00_x_core::infrastructure::try_get_path_manager_arc;
use ai00_x_core::service::config::types::GlobalConfig;
use dark_light::Mode;
use log::debug;

#[derive(Debug, Clone)]
pub struct ThemeConfig {
    pub id: String,
    pub bg_primary: String,
    pub bg_secondary: String,
    pub bg_scene: String,
    pub is_light: bool,
    pub text_primary: String,
    pub text_muted: String,
    pub accent_color: String,
}

impl Default for ThemeConfig {
    fn default() -> Self {
        Self::dark()
    }
}

impl ThemeConfig {
    pub fn dark() -> Self {
        Self {
            id: "ai00-x-dark".to_string(),
            bg_primary: "#121214".to_string(),
            bg_secondary: "#18181a".to_string(),
            bg_scene: "#16161a".to_string(),
            is_light: false,
            text_primary: "#e8e8e8".to_string(),
            text_muted: "rgba(255, 255, 255, 0.4)".to_string(),
            accent_color: "#60a5fa".to_string(),
        }
    }

    pub fn light() -> Self {
        Self {
            id: "ai00-x-light".to_string(),
            bg_primary: "#f3f3f5".to_string(),
            bg_secondary: "#ffffff".to_string(),
            bg_scene: "#ffffff".to_string(),
            is_light: true,
            text_primary: "#1e293b".to_string(),
            text_muted: "#64748b".to_string(),
            accent_color: "#64748b".to_string(),
        }
    }

    pub fn with_accent_hue(mut self, hue: u16) -> Self {
        let (r, g, b) = hsl_to_rgb(hue, 72, if self.is_light { 45 } else { 65 });
        self.accent_color = format!("#{:02x}{:02x}{:02x}", r, g, b);
        self
    }

    pub fn load_from_config() -> Self {
        let default = Self::default();

        let path_manager = match try_get_path_manager_arc() {
            Ok(pm) => pm,
            Err(e) => {
                debug!("Failed to create PathManager, using default theme: {}", e);
                return default;
            }
        };

        let config_file = path_manager.app_config_file();
        if !config_file.exists() {
            return default;
        }

        let config_content = match std::fs::read_to_string(&config_file) {
            Ok(content) => content,
            Err(e) => {
                debug!("Failed to read config file, using default theme: {}", e);
                return default;
            }
        };

        let global_config: GlobalConfig = match serde_json::from_str(&config_content) {
            Ok(config) => config,
            Err(e) => {
                debug!("Failed to parse config file, using default theme: {}", e);
                return default;
            }
        };

        let theme_id = global_config
            .themes
            .as_ref()
            .map(|t| t.current.as_str())
            .unwrap_or("system");

        let is_light = Self::resolve_is_light(theme_id);

        let accent_hue = global_config
            .themes
            .as_ref()
            .map(|t| t.accent_hue)
            .unwrap_or(-1);

        let theme = if is_light {
            Self::light()
        } else {
            Self::dark()
        };

        if accent_hue >= 0 {
            theme.with_accent_hue(accent_hue as u16)
        } else {
            theme
        }
    }

    fn resolve_is_light(theme_id: &str) -> bool {
        if theme_id == "system" {
            return !matches!(dark_light::detect(), Mode::Dark);
        }
        theme_id.contains("light")
    }

    pub fn generate_init_script(&self) -> String {
        let theme_type = if self.is_light { "light" } else { "dark" };

        format!(
            r#"
            (function() {{
                function applyTheme() {{
                    var root = document.documentElement;
                    if (!root) return false;

                    root.setAttribute('data-theme', '{id}');
                    root.setAttribute('data-theme-type', '{theme_type}');

                    console.log('[Theme] Pre-injected theme: {id}');
                    return true;
                }}

                if (document.documentElement) {{
                    applyTheme();
                }}

                if (document.readyState === 'loading') {{
                    document.addEventListener('DOMContentLoaded', applyTheme);
                }} else {{
                    applyTheme();
                }}
            }})();
            "#,
            id = self.id,
            theme_type = theme_type,
        )
    }

    pub fn to_tauri_color(&self) -> tauri::window::Color {
        let hex = self.bg_primary.trim_start_matches('#');
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(18);
        let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(18);
        let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(20);
        tauri::window::Color(r, g, b, 255)
    }
}

fn hsl_to_rgb(h: u16, s: u32, l: u32) -> (u8, u8, u8) {
    let h = h as f64 / 360.0;
    let s = s as f64 / 100.0;
    let l = l as f64 / 100.0;

    let a = s * l.min(1.0 - l);

    let f = |n: f64| {
        let k = (n + h * 12.0) % 12.0;
        let color = l - a * (k - 3.0).min(9.0 - k).clamp(-1.0, 1.0);
        (color * 255.0).round() as u8
    };

    (f(0.0), f(8.0), f(4.0))
}

#[tauri::command]
pub async fn open_overlay_force(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let overlay_url = format!(
        "{}/main/",
        ai00_x_core::service::config::server_endpoints::local_web_origin()
    );
    let reload_js = format!(
        "try{{window.location.href='{}?r='+Date.now();}}catch(e){{try{{window.location.reload();}}catch{{}}}}",
        overlay_url
    );

    if let Some(window) = app.get_webview_window("overlay") {
        crate::overlay::fit_overlay_to_monitor(&window);
        let _ = window.eval(&reload_js);
        crate::overlay::spawn_overlay_thread(app);
        Ok(())
    } else {
        let url = tauri::WebviewUrl::External(
            overlay_url
                .parse()
                .map_err(|e| format!("invalid overlay url: {}", e))?,
        );

        let window = tauri::WebviewWindowBuilder::new(&app, "overlay", url)
            .title(" ")
            .inner_size(800.0, 600.0)
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(true)
            .skip_taskbar(true)
            .always_on_top(true)
            .closable(false)
            .visible(false)
            .focused(false)
            .build()
            .map_err(|e| format!("build overlay failed: {}", e))?;

        // Open devtools for debugging overlay (remove after debugging)
        window.open_devtools();
        log::info!("Overlay devtools opened");

        crate::overlay::fit_overlay_to_monitor(&window);
        crate::overlay::spawn_overlay_thread(app);
        Ok(())
    }
}

#[tauri::command]
pub async fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if let Some(main_window) = app.get_webview_window("overlay") {
        crate::overlay::fit_overlay_to_monitor(&main_window);

        main_window.show().map_err(|e| {
            log::error!("Failed to show overlay window: {}", e);
            format!("Failed to show overlay window: {}", e)
        })?;

        main_window.set_focus().map_err(|e| {
            log::error!("Failed to focus overlay window: {}", e);
            format!("Failed to focus overlay window: {}", e)
        })?;
    } else {
        log::error!("Overlay window not found");
        return Err("Overlay window not found".to_string());
    }

    if let Some(loader_window) = app.get_webview_window("loader") {
        let _ = loader_window.hide();
    }

    Ok(())
}

#[tauri::command]
pub async fn hide_loader_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if let Some(loader_window) = app.get_webview_window("loader") {
        loader_window.hide().map_err(|e| {
            log::error!("Failed to hide loader window: {}", e);
            format!("Failed to hide loader window: {}", e)
        })?;
    }

    Ok(())
}
