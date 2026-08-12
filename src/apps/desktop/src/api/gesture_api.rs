use crate::api::app_state::AppState;
use crate::theme;
use ai00_x_core::service::config::types::{
    GestureBinding, GestureConfig, GestureTemplateConfig, SavedAction,
};
use ai00_x_core::util::gesture_recognizer::{detect_closed_shape, encode_8dir, MatchResult};
use ai00_x_core::util::pattern_recognizer::PatternRecognizer;
use device_query::{DeviceQuery, DeviceState};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager, State};

const RIGHT_BUTTON: usize = 2;
const MIDDLE_BUTTON: usize = 3;
const GRID_SIZE: u32 = 3;
const POLL_INTERVAL_MS: u64 = 16;
const CIRCLE_PADDING: f64 = 70.0;
const CIRCLE_BG_SCALE: f64 = 1.6;
const MIN_TRAIL_POINTS: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq)]
enum TrackerState {
    Idle,
    Active,
}

#[derive(Debug, Clone, Serialize)]
pub struct PatternActivatedEvent {
    pub center_x: i32,
    pub center_y: i32,
    pub grid_size: u32,
    pub grid_spacing: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PatternMatchedEvent {
    pub name: String,
    pub score: f64,
    pub sequence: Vec<u32>,
    pub start_x: i32,
    pub start_y: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct GestureTrailEvent {
    pub points: Vec<(i32, i32)>,
    pub gesture_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GestureTrailPointEvent {
    pub x: i32,
    pub y: i32,
}

struct GridConfig {
    grid_spacing: f64,
    dot_radius: f64,
}

impl Default for GridConfig {
    fn default() -> Self {
        Self {
            grid_spacing: 80.0,
            dot_radius: 25.0,
        }
    }
}

pub(crate) struct PatternTracker {
    state: TrackerState,
    center: Option<(i32, i32)>,
    grid_config: GridConfig,
    recognizer: PatternRecognizer,
}

impl PatternTracker {
    pub fn new() -> Self {
        Self {
            state: TrackerState::Idle,
            center: None,
            grid_config: GridConfig::default(),
            recognizer: PatternRecognizer::new(),
        }
    }

    pub fn load_config(&mut self, config: &GestureConfig) {
        self.grid_config.grid_spacing = config.grid_spacing;
        self.grid_config.dot_radius = config.dot_radius;
        self.recognizer.load_templates(config.templates.clone());

        log::info!(
            "[Pattern] Loaded config: grid=5x5, spacing={}, templates={}",
            config.grid_spacing,
            config.templates.len(),
        );
    }

    pub fn on_middle_click(&mut self, x: i32, y: i32) -> Option<PatternActivatedEvent> {
        match self.state {
            TrackerState::Idle => {
                self.state = TrackerState::Active;
                self.center = Some((x, y));
                Some(PatternActivatedEvent {
                    center_x: x,
                    center_y: y,
                    grid_size: GRID_SIZE,
                    grid_spacing: self.grid_config.grid_spacing,
                })
            }
            TrackerState::Active => {
                self.reset();
                None
            }
        }
    }

    /// Activate tracker from a circle gesture (same as middle click but always activates).
    pub fn on_circle_activate(&mut self, x: i32, y: i32) -> (f64, Option<PatternActivatedEvent>) {
        self.state = TrackerState::Active;
        self.center = Some((x, y));
        let spacing = self.grid_config.grid_spacing;
        (
            spacing,
            Some(PatternActivatedEvent {
                center_x: x,
                center_y: y,
                grid_size: GRID_SIZE,
                grid_spacing: spacing,
            }),
        )
    }

    pub fn is_active(&self) -> bool {
        self.state == TrackerState::Active
    }

    pub fn is_click_outside(&self, x: i32, y: i32) -> bool {
        if let Some((cx, cy)) = self.center {
            let svg_size =
                (GRID_SIZE as f64 - 1.0) * self.grid_config.grid_spacing + CIRCLE_PADDING * 2.0;
            let radius = svg_size * CIRCLE_BG_SCALE / 2.0;
            let dx = (x - cx) as f64;
            let dy = (y - cy) as f64;
            (dx * dx + dy * dy) > (radius * radius)
        } else {
            false
        }
    }

    pub fn reset(&mut self) {
        self.state = TrackerState::Idle;
        self.center = None;
    }

    pub fn recognize(&self, sequence: &[u32]) -> Option<PatternMatchedEvent> {
        let result = self.recognizer.recognize(sequence)?;
        let (cx, cy) = self.center.unwrap_or((0, 0));
        Some(PatternMatchedEvent {
            name: result.name,
            score: result.score,
            sequence: sequence.to_vec(),
            start_x: cx,
            start_y: cy,
        })
    }
}

impl Default for PatternTracker {
    fn default() -> Self {
        Self::new()
    }
}

pub struct GestureState {
    pub running: AtomicBool,
    pub enabled: AtomicBool,
    pub(crate) tracker: Mutex<PatternTracker>,
}

impl Default for GestureState {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            enabled: AtomicBool::new(true),
            tracker: Mutex::new(PatternTracker::new()),
        }
    }
}

pub fn start_gesture_listener(app: tauri::AppHandle, running: Arc<AtomicBool>) {
    thread::spawn(move || {
        let device_state = DeviceState::new();
        let mut last_middle_pressed = false;
        let mut last_left_pressed = false;
        let mut last_right_pressed = false;

        // Right-button drag gesture state
        let mut right_dragging = false;
        let mut trail_points: Vec<(i32, i32)> = Vec::new();

        log::info!(
            "[Gesture] Listener thread started, right_button={}, middle_button={}",
            RIGHT_BUTTON,
            MIDDLE_BUTTON
        );

        while running.load(Ordering::SeqCst) {
            let enabled = app
                .try_state::<GestureState>()
                .is_none_or(|s| s.enabled.load(Ordering::SeqCst));

            let mouse = device_state.get_mouse();
            let right_pressed = mouse
                .button_pressed
                .get(RIGHT_BUTTON)
                .copied()
                .unwrap_or(false);
            let middle_pressed = mouse
                .button_pressed
                .get(MIDDLE_BUTTON)
                .copied()
                .unwrap_or(false);
            let left_pressed = mouse.button_pressed.get(1).copied().unwrap_or(false);
            let (x, y) = mouse.coords;

            // --- Right-button drag gesture detection ---
            if enabled {
                if right_pressed && !last_right_pressed {
                    // Right button just pressed: start tracking
                    right_dragging = true;
                    trail_points.clear();
                    trail_points.push((x, y));
                    let _ = app.emit("gesture_trail_start", ());
                    log::info!("[Gesture] Right button pressed at ({}, {})", x, y);
                } else if right_pressed && right_dragging {
                    // Right button held: accumulate trail points
                    if let Some(&(lx, ly)) = trail_points.last() {
                        let dx = (x - lx).abs();
                        let dy = (y - ly).abs();
                        if dx > 2 || dy > 2 {
                            trail_points.push((x, y));
                            // Emit real-time trail point for live particle effect
                            let _ =
                                app.emit("gesture_trail_point", &GestureTrailPointEvent { x, y });
                        }
                    }
                } else if !right_pressed && last_right_pressed && right_dragging {
                    // Right button released: recognize gesture
                    right_dragging = false;
                    let recognized = recognize_right_drag(&trail_points);
                    match recognized {
                        RightDragGesture::ShowUnderlay => {
                            log::info!("[Gesture] Recognized: left-then-down (ShowUnderlay)");
                            suppress_context_menu();
                            crate::underlay::ensure(&app);
                            let _ = app.emit("gesture_action_show_underlay", ());
                            let _ = app.emit(
                                "gesture_trail",
                                &GestureTrailEvent {
                                    points: trail_points.clone(),
                                    gesture_type: "show_underlay".to_string(),
                                },
                            );
                        }
                        RightDragGesture::HideUnderlay => {
                            log::info!("[Gesture] Recognized: left-then-up (HideUnderlay)");
                            suppress_context_menu();
                            crate::underlay::cleanup(&app);
                            let _ = app.emit("gesture_action_hide_underlay", ());
                            let _ = app.emit(
                                "gesture_trail",
                                &GestureTrailEvent {
                                    points: trail_points.clone(),
                                    gesture_type: "hide_underlay".to_string(),
                                },
                            );
                        }
                        RightDragGesture::Circle => {
                            log::info!("[Gesture] Recognized: closed circle (PatternGrid)");
                            suppress_context_menu();
                            // Calculate circle center as centroid of trail
                            let (cx, cy) = centroid_of_points(&trail_points);
                            let (_grid_spacing, activate_evt) = {
                                let state = app.state::<GestureState>();
                                let mut t = state.tracker.lock().unwrap();
                                // Set tracker to active so left-click outside can cancel it
                                t.on_circle_activate(cx, cy)
                            };
                            if let Some(evt) = activate_evt {
                                let _ = app.emit("pattern_activated", &evt);
                            }
                            let _ = app.emit(
                                "gesture_trail",
                                &GestureTrailEvent {
                                    points: trail_points.clone(),
                                    gesture_type: "circle".to_string(),
                                },
                            );
                        }
                        RightDragGesture::None => {
                            // Not enough points or no match, still emit trail end so UI fades out
                            if trail_points.len() >= MIN_TRAIL_POINTS {
                                log::info!(
                                    "[Gesture] Right drag released with {} points, no gesture matched",
                                    trail_points.len()
                                );
                            }
                            let _ = app.emit(
                                "gesture_trail",
                                &GestureTrailEvent {
                                    points: trail_points.clone(),
                                    gesture_type: "none".to_string(),
                                },
                            );
                        }
                    }
                    trail_points.clear();
                }
            }

            // --- Middle button: toggle pattern grid (existing behavior) ---
            if enabled && middle_pressed && !last_middle_pressed {
                log::info!("[Gesture] Middle click at ({}, {})", x, y);

                let was_active = {
                    let state = app.state::<GestureState>();
                    let t = state.tracker.lock().unwrap();
                    t.is_active()
                };

                if was_active {
                    let state = app.state::<GestureState>();
                    let mut t = state.tracker.lock().unwrap();
                    t.reset();
                    let _ = app.emit("pattern_cancelled", ());
                    log::info!("[Gesture] Pattern cancelled");
                } else {
                    let activate = {
                        let state = app.state::<GestureState>();
                        let mut t = state.tracker.lock().unwrap();
                        t.on_middle_click(x, y)
                    };

                    if let Some(evt) = activate {
                        let _ = app.emit("pattern_activated", &evt);
                        log::info!(
                            "[Gesture] Pattern activated at ({}, {})",
                            evt.center_x,
                            evt.center_y
                        );
                    }
                }
            }

            // --- Left click: cancel pattern grid if active ---
            if left_pressed && !last_left_pressed {
                let should_cancel = {
                    let state = app.state::<GestureState>();
                    let t = state.tracker.lock().unwrap();
                    t.is_active() && t.is_click_outside(x, y)
                };
                if should_cancel {
                    let state = app.state::<GestureState>();
                    let mut t = state.tracker.lock().unwrap();
                    t.reset();
                    let _ = app.emit("pattern_cancelled", ());
                    log::info!("[Gesture] Pattern cancelled by left click outside");
                }
            }

            last_right_pressed = right_pressed;
            last_middle_pressed = middle_pressed;
            last_left_pressed = left_pressed;
            thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        }
    });
}

/// Result of right-button drag gesture recognition.
#[derive(Debug, Clone, Copy, PartialEq)]
enum RightDragGesture {
    ShowUnderlay,
    HideUnderlay,
    Circle,
    None,
}

/// Recognize a right-button drag gesture from the trail points.
fn recognize_right_drag(trail: &[(i32, i32)]) -> RightDragGesture {
    if trail.len() < MIN_TRAIL_POINTS {
        return RightDragGesture::None;
    }

    // Convert to f64 points for gesture_recognizer
    let f64_points: Vec<(f64, f64)> = trail.iter().map(|&(x, y)| (x as f64, y as f64)).collect();

    // Priority 1: Check for closed circle
    if let Some(MatchResult::ClosedShape { name, .. }) = detect_closed_shape(&f64_points) {
        if name == "circle" {
            return RightDragGesture::Circle;
        }
    }

    // Priority 2: Check two-segment direction (down-then-left / down-then-right)
    // Split trail into two halves and detect dominant direction of each half
    let mid = trail.len() / 2;
    let first_half = &trail[..=mid];
    let second_half = &trail[mid..];

    if let (Some(first_dir), Some(second_dir)) = (
        dominant_direction(first_half),
        dominant_direction(second_half),
    ) {
        log::info!(
            "[Gesture] Two-segment: first={:?}, second={:?}",
            first_dir,
            second_dir
        );

        // "先左再下": first segment goes left, second goes down -> show smart desktop
        if first_dir == SimpleDir::Left && second_dir == SimpleDir::Down {
            return RightDragGesture::ShowUnderlay;
        }

        // "先左再上": first segment goes left, second goes up -> switch to original desktop
        if first_dir == SimpleDir::Left && second_dir == SimpleDir::Up {
            return RightDragGesture::HideUnderlay;
        }
    }

    // Fallback: try encode_8dir for more complex patterns
    let code = encode_8dir(&f64_points);
    if !code.is_empty() {
        log::info!("[Gesture] Direction code fallback: {}", code);

        // "先左再下": West(4) then South(6) -> show smart desktop
        if contains_direction_sequence(&code, '4', '6') {
            return RightDragGesture::ShowUnderlay;
        }
        // "先左再上": West(4) then North(2) -> switch to original desktop
        if contains_direction_sequence(&code, '4', '2') {
            return RightDragGesture::HideUnderlay;
        }
    }

    RightDragGesture::None
}

/// Simple 4-direction classification.
#[derive(Debug, Clone, Copy, PartialEq)]
enum SimpleDir {
    Up,
    Down,
    Left,
    Right,
}

/// Detect the dominant direction of a trail segment.
/// Uses the vector from first point to last point, requiring minimum displacement.
fn dominant_direction(points: &[(i32, i32)]) -> Option<SimpleDir> {
    if points.len() < 2 {
        return None;
    }

    let start = points[0];
    let end = points[points.len() - 1];
    let dx = (end.0 - start.0) as f64;
    let dy = (end.1 - start.1) as f64;
    let distance = (dx * dx + dy * dy).sqrt();

    // Minimum displacement to consider a direction valid
    if distance < 30.0 {
        return None;
    }

    let angle = dy.atan2(dx).to_degrees();

    // Screen coordinates: Y increases downward
    // angle=0 → right, angle=90 → down, angle=±180 → left, angle=-90 → up
    Some(if angle > -45.0 && angle <= 45.0 {
        SimpleDir::Right
    } else if angle > 45.0 && angle <= 135.0 {
        SimpleDir::Down
    } else if angle > -135.0 && angle <= -45.0 {
        SimpleDir::Up
    } else {
        SimpleDir::Left
    })
}

/// Check if the direction code contains a sequence where `first` direction appears
/// before `second` direction, allowing intermediate directions between them.
fn contains_direction_sequence(code: &str, first: char, second: char) -> bool {
    let chars: Vec<char> = code.chars().collect();
    let mut found_first = false;
    for &c in &chars {
        if c == first {
            found_first = true;
        } else if found_first && c == second {
            return true;
        }
    }
    false
}

/// Calculate the centroid of a set of points.
fn centroid_of_points(points: &[(i32, i32)]) -> (i32, i32) {
    if points.is_empty() {
        return (0, 0);
    }
    let sum_x: i64 = points.iter().map(|p| p.0 as i64).sum();
    let sum_y: i64 = points.iter().map(|p| p.1 as i64).sum();
    let n = points.len() as i64;
    ((sum_x / n) as i32, (sum_y / n) as i32)
}

fn sync_tracker_config(app: &tauri::AppHandle, config: &GestureConfig) {
    if let Some(gesture_state) = app.try_state::<GestureState>() {
        gesture_state
            .enabled
            .store(config.enabled, Ordering::SeqCst);
        let mut t = gesture_state.tracker.lock().unwrap();
        t.load_config(config);
    }
}

#[tauri::command]
pub fn start_gesture_detection(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<GestureState>();
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let running = Arc::new(AtomicBool::new(true));
    start_gesture_listener(app, running);
    Ok(())
}

#[tauri::command]
pub fn stop_gesture_detection(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<GestureState>();
    state.running.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn match_pattern(
    app: tauri::AppHandle,
    sequence: Vec<u32>,
    _start_x: i32,
    _start_y: i32,
) -> Result<Option<PatternMatchedEvent>, String> {
    let state = app.state::<GestureState>();
    let mut t = state.tracker.lock().unwrap();

    if sequence.len() < 2 {
        t.reset();
        let _ = app.emit("pattern_cancelled", ());
        return Ok(None);
    }

    let matched = t.recognize(&sequence);
    t.reset();

    if let Some(ref match_evt) = matched {
        log::info!(
            "[Pattern] Matched: {} (score={:.2})",
            match_evt.name,
            match_evt.score
        );
        let _ = app.emit("pattern_matched", match_evt);
    } else {
        log::info!("[Pattern] No match found for sequence {:?}", sequence);
        let _ = app.emit("pattern_cancelled", ());
    }

    Ok(matched)
}

#[tauri::command]
pub fn cancel_pattern(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<GestureState>();
    let mut t = state.tracker.lock().unwrap();
    t.reset();
    let _ = app.emit("pattern_cancelled", ());
    log::info!("[Pattern] Cancelled");
    Ok(())
}

async fn load_gesture_config(
    config_service: &ai00_x_core::service::config::ConfigService,
) -> GestureConfig {
    config_service
        .get_config(Some("gesture"))
        .await
        .unwrap_or_default()
}

async fn save_gesture_config(
    config_service: &ai00_x_core::service::config::ConfigService,
    gesture: &GestureConfig,
) -> Result<(), String> {
    let gesture_value =
        serde_json::to_value(gesture).map_err(|e| format!("Failed to serialize: {}", e))?;
    config_service
        .set_config("gesture", gesture_value)
        .await
        .map_err(|e| format!("Failed to save: {}", e))?;
    let _ = ai00_x_core::service::config::reload_global_config().await;
    Ok(())
}

#[tauri::command]
pub async fn get_gesture_config(state: State<'_, AppState>) -> Result<GestureConfig, String> {
    let gesture = load_gesture_config(&state.config_service).await;
    Ok(gesture)
}

#[tauri::command]
pub async fn set_gesture_config(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    config: GestureConfig,
) -> Result<(), String> {
    save_gesture_config(&state.config_service, &config).await?;
    sync_tracker_config(&app, &config);
    Ok(())
}

#[tauri::command]
pub async fn add_gesture_template(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    template: GestureTemplateConfig,
) -> Result<(), String> {
    let mut gesture = load_gesture_config(&state.config_service).await;

    gesture.templates.retain(|t| t.name != template.name);
    gesture.templates.push(template);

    save_gesture_config(&state.config_service, &gesture).await?;
    sync_tracker_config(&app, &gesture);
    Ok(())
}

#[tauri::command]
pub async fn remove_gesture_template(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let mut gesture = load_gesture_config(&state.config_service).await;

    gesture.templates.retain(|t| t.name != name);
    gesture.bindings.retain(|b| b.gesture_name != name);

    save_gesture_config(&state.config_service, &gesture).await?;
    sync_tracker_config(&app, &gesture);
    Ok(())
}

#[tauri::command]
pub async fn set_gesture_bindings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    bindings: Vec<GestureBinding>,
) -> Result<(), String> {
    let mut gesture = load_gesture_config(&state.config_service).await;
    gesture.bindings = bindings;
    save_gesture_config(&state.config_service, &gesture).await?;
    sync_tracker_config(&app, &gesture);
    Ok(())
}

#[tauri::command]
pub async fn add_saved_action(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    action: SavedAction,
) -> Result<(), String> {
    let mut gesture = load_gesture_config(&state.config_service).await;
    gesture.saved_actions.retain(|a| a.id != action.id);
    gesture.saved_actions.push(action);
    save_gesture_config(&state.config_service, &gesture).await?;
    sync_tracker_config(&app, &gesture);
    Ok(())
}

#[tauri::command]
pub async fn remove_saved_action(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let mut gesture = load_gesture_config(&state.config_service).await;
    gesture.saved_actions.retain(|a| a.id != id);
    save_gesture_config(&state.config_service, &gesture).await?;
    sync_tracker_config(&app, &gesture);
    Ok(())
}

#[tauri::command]
pub async fn update_saved_action(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    action: SavedAction,
) -> Result<(), String> {
    let mut gesture = load_gesture_config(&state.config_service).await;
    if let Some(existing) = gesture.saved_actions.iter_mut().find(|a| a.id == action.id) {
        *existing = action;
    }
    save_gesture_config(&state.config_service, &gesture).await?;
    sync_tracker_config(&app, &gesture);
    Ok(())
}

#[tauri::command]
pub async fn execute_custom_command(app: tauri::AppHandle, command: String) -> Result<(), String> {
    log::info!("[Pattern] Executing custom command: {}", command);

    match command.as_str() {
        "open_main" | "show_main" => {
            theme::show_main_window(app).await?;
        }
        "open_settings" => {
            if let Err(e) =
                crate::task_window::open_task_window(app.clone(), None, None, Some(true), None)
                    .await
            {
                log::warn!("open_settings: failed to open task window: {}", e);
            }
        }
        "show_underlay" | "open_underlay" => {
            crate::underlay::ensure(&app);
        }
        "hide_underlay" | "close_underlay" => {
            crate::underlay::cleanup(&app);
        }
        cmd => {
            let _ = app.emit("gesture_custom_command", cmd);
            #[cfg(target_os = "windows")]
            {
                let _ = ai00_x_core::util::process_manager::create_command("cmd")
                    .args(["/C", cmd])
                    .spawn();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = std::process::Command::new("sh").args(["-c", cmd]).spawn();
            }
        }
    }

    Ok(())
}

/// Suppress the context menu that would appear after a right-button gesture.
/// Sends an Escape key press to dismiss any right-click context menu.
#[cfg(target_os = "windows")]
fn suppress_context_menu() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_TYPE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY,
    };

    // Small delay to let the context menu appear first
    thread::sleep(Duration::from_millis(50));

    let vk_esc = VIRTUAL_KEY(0x1B); // VK_ESCAPE

    unsafe {
        // Key down
        let input_down = INPUT {
            r#type: INPUT_TYPE(1), // INPUT_KEYBOARD
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk_esc,
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(0), // key down
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        // Key up
        let input_up = INPUT {
            r#type: INPUT_TYPE(1),
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk_esc,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        let inputs = [input_down, input_up];
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(not(target_os = "windows"))]
fn suppress_context_menu() {
    // No-op on non-Windows platforms
}
