use crate::audio_capture::AudioCaptureSession;
use crate::model_init;
use cpal::traits::{DeviceTrait, HostTrait};
use device_query::{DeviceQuery, DeviceState};
use enigo::{Enigo, Keyboard, Settings};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::{Duration, Instant};
use tauri::Emitter;

fn f32_to_i32_bits(v: f32) -> i32 {
    v.to_bits() as i32
}

fn i32_bits_to_f32(v: i32) -> f32 {
    f32::from_bits(v as u32)
}

const DEFAULT_TRIGGER_BITS: i32 = (0.8_f32.to_bits()) as i32;
const DEFAULT_CHARGE_DELAY_BITS: i32 = (0.4_f32.to_bits()) as i32;

static GLOBAL_VOICE_INPUT_RUNNING: AtomicBool = AtomicBool::new(false);
static GLOBAL_VOICE_INPUT_SHUTDOWN: AtomicBool = AtomicBool::new(false);
static GLOBAL_VOICE_INPUT_RECORDING: AtomicBool = AtomicBool::new(false);
static VOICE_TRIGGER_DURATION: AtomicI32 = AtomicI32::new(DEFAULT_TRIGGER_BITS);
static VOICE_CHARGE_DELAY: AtomicI32 = AtomicI32::new(DEFAULT_CHARGE_DELAY_BITS);

#[derive(Clone, Serialize)]
pub struct VoiceInputPositionEvent {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Serialize)]
pub struct VoiceInputStoppedEvent {
    pub x: f64,
    pub y: f64,
    pub duration_ms: u64,
}

#[derive(Clone, Serialize)]
pub struct VoiceInputAsrDoneEvent {
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct VoiceInputChargingEvent {
    pub x: f64,
    pub y: f64,
    pub progress: f32,
}

#[derive(Clone, Serialize)]
pub struct VoiceInputChargeCancelEvent {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Serialize)]
pub struct VoiceInputErrorEvent {
    pub message: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Serialize)]
pub struct GlobalVoiceInputStatus {
    pub running: bool,
    pub recording: bool,
}

fn transcribe_pcm_samples(samples: Vec<f32>) -> Result<String, String> {
    model_init::transcribe_pcm(samples).map_err(|e| format!("Transcription failed: {}", e))
}

fn emit_voice_input_started(app: &tauri::AppHandle, screen_x: i32, screen_y: i32) {
    let payload = VoiceInputPositionEvent {
        x: screen_x as f64,
        y: screen_y as f64,
    };
    let _ = app.emit("voice_input_started", payload);
}

fn emit_voice_input_charging(app: &tauri::AppHandle, screen_x: i32, screen_y: i32, progress: f32) {
    let payload = VoiceInputChargingEvent {
        x: screen_x as f64,
        y: screen_y as f64,
        progress,
    };
    let _ = app.emit("voice_input_charging", payload);
}

fn emit_voice_input_charge_cancel(app: &tauri::AppHandle, screen_x: i32, screen_y: i32) {
    let payload = VoiceInputChargeCancelEvent {
        x: screen_x as f64,
        y: screen_y as f64,
    };
    let _ = app.emit("voice_input_charge_cancel", payload);
}

fn emit_voice_input_stopped(
    app: &tauri::AppHandle,
    screen_x: i32,
    screen_y: i32,
    duration_ms: u64,
) {
    let payload = VoiceInputStoppedEvent {
        x: screen_x as f64,
        y: screen_y as f64,
        duration_ms,
    };
    let _ = app.emit("voice_input_stopped", payload);
}

fn emit_voice_input_asr_done(app: &tauri::AppHandle, payload: VoiceInputAsrDoneEvent) {
    let _ = app.emit("voice_input_asr_done", payload);
}

fn emit_voice_input_error(app: &tauri::AppHandle, message: String, screen_x: i32, screen_y: i32) {
    let payload = VoiceInputErrorEvent {
        message,
        x: screen_x as f64,
        y: screen_y as f64,
    };
    let _ = app.emit("voice_input_error", payload);
}

fn is_left_button_pressed(button_pressed: &[bool]) -> bool {
    button_pressed.get(1).copied().unwrap_or(false)
        || button_pressed.first().copied().unwrap_or(false)
}

fn inject_text_with_enigo(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.text(text).map_err(|e| e.to_string())
}

fn run_global_voice_input_loop(app: tauri::AppHandle) {
    let device_state = DeviceState::new();
    let mut press_started_at: Option<Instant> = None;
    let mut press_origin: Option<(i32, i32)> = None;
    let mut moved = false;
    let mut charge_active = false;
    let mut charge_visual_started = false;
    let mut last_charge_emit = Instant::now() - Duration::from_secs(1);
    let mut capture_session: Option<AudioCaptureSession> = None;
    let mut recording_started_at: Option<Instant> = None;

    let record_trigger_secs: f32 = i32_bits_to_f32(VOICE_TRIGGER_DURATION.load(Ordering::SeqCst));
    let charge_show_delay_secs: f32 = i32_bits_to_f32(VOICE_CHARGE_DELAY.load(Ordering::SeqCst));
    let charge_fill_secs = record_trigger_secs - charge_show_delay_secs;

    while !GLOBAL_VOICE_INPUT_SHUTDOWN.load(Ordering::SeqCst) {
        let mouse = device_state.get_mouse();
        let left_pressed = is_left_button_pressed(&mouse.button_pressed);
        let (x, y) = mouse.coords;

        if left_pressed {
            if press_started_at.is_none() {
                press_started_at = Some(Instant::now());
                press_origin = Some((x, y));
                moved = false;
                charge_active = true;
                charge_visual_started = false;
                last_charge_emit = Instant::now() - Duration::from_secs(1);
            } else if let Some((ox, oy)) = press_origin {
                let dx = x - ox;
                let dy = y - oy;
                if dx * dx + dy * dy > 25 {
                    if !moved && charge_active && charge_visual_started && capture_session.is_none()
                    {
                        emit_voice_input_charge_cancel(&app, x, y);
                        charge_active = false;
                        charge_visual_started = false;
                    }
                    moved = true;
                }
            }

            if !moved && capture_session.is_none() {
                if let Some(started) = press_started_at {
                    let elapsed_secs = started.elapsed().as_secs_f32();
                    if charge_active
                        && !charge_visual_started
                        && elapsed_secs >= charge_show_delay_secs
                    {
                        emit_voice_input_charging(&app, x, y, 0.0);
                        charge_visual_started = true;
                        last_charge_emit = Instant::now();
                    }
                    if charge_active
                        && last_charge_emit.elapsed() >= Duration::from_millis(50)
                        && charge_visual_started
                    {
                        let progress = ((elapsed_secs - charge_show_delay_secs) / charge_fill_secs)
                            .clamp(0.0, 1.0);
                        emit_voice_input_charging(&app, x, y, progress);
                        last_charge_emit = Instant::now();
                    }
                    if elapsed_secs >= record_trigger_secs {
                        match AudioCaptureSession::start_default_input() {
                            Ok(session) => {
                                charge_active = false;
                                charge_visual_started = false;
                                emit_voice_input_started(&app, x, y);
                                GLOBAL_VOICE_INPUT_RECORDING.store(true, Ordering::SeqCst);
                                recording_started_at = Some(Instant::now());
                                capture_session = Some(session);
                            }
                            Err(e) => emit_voice_input_error(&app, e, x, y),
                        }
                    }
                }
            }
        } else {
            if let Some(mut session) = capture_session.take() {
                let elapsed = recording_started_at
                    .map(|start| start.elapsed().as_millis() as u64)
                    .unwrap_or(0);
                emit_voice_input_stopped(&app, x, y, elapsed);
                GLOBAL_VOICE_INPUT_RECORDING.store(false, Ordering::SeqCst);
                recording_started_at = None;

                match session.stop_and_take_samples() {
                    Ok(samples) => {
                        if samples.len() > 1600 {
                            match transcribe_pcm_samples(samples) {
                                Ok(text) => {
                                    let normalized = text.trim().to_string();
                                    if !normalized.is_empty() {
                                        match inject_text_with_enigo(&normalized) {
                                            Ok(_) => {
                                                emit_voice_input_asr_done(
                                                    &app,
                                                    VoiceInputAsrDoneEvent { text: normalized },
                                                );
                                            }
                                            Err(e) => emit_voice_input_error(&app, e, x, y),
                                        }
                                    }
                                }
                                Err(e) => emit_voice_input_error(&app, e, x, y),
                            }
                        }
                    }
                    Err(e) => emit_voice_input_error(&app, e, x, y),
                }
            }
            if charge_active && charge_visual_started {
                emit_voice_input_charge_cancel(&app, x, y);
            }
            charge_active = false;
            charge_visual_started = false;
            press_started_at = None;
            press_origin = None;
            moved = false;
        }

        std::thread::sleep(Duration::from_millis(20));
    }

    if let Some(mut session) = capture_session {
        let _ = session.stop_and_take_samples();
    }
    GLOBAL_VOICE_INPUT_RECORDING.store(false, Ordering::SeqCst);
    GLOBAL_VOICE_INPUT_RUNNING.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub async fn start_global_voice_input_service(app: tauri::AppHandle) -> Result<(), String> {
    if GLOBAL_VOICE_INPUT_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    GLOBAL_VOICE_INPUT_RECORDING.store(false, Ordering::SeqCst);
    GLOBAL_VOICE_INPUT_SHUTDOWN.store(false, Ordering::SeqCst);

    let config_service = ai00_x_core::service::config::get_global_config_service();
    if let Ok(svc) = config_service {
        if let Ok(voice_input) = svc
            .get_config::<ai00_x_core::service::config::types::VoiceInputConfig>(Some(
                "voice_input",
            ))
            .await
        {
            if voice_input.trigger_duration_secs > 0.0 {
                VOICE_TRIGGER_DURATION.store(
                    f32_to_i32_bits(voice_input.trigger_duration_secs),
                    Ordering::SeqCst,
                );
            }
            if voice_input.charge_show_delay_secs >= 0.0 {
                VOICE_CHARGE_DELAY.store(
                    f32_to_i32_bits(voice_input.charge_show_delay_secs),
                    Ordering::SeqCst,
                );
            }
        }
    }

    std::thread::spawn(move || run_global_voice_input_loop(app));
    Ok(())
}

#[tauri::command]
pub fn stop_global_voice_input_service() -> Result<(), String> {
    GLOBAL_VOICE_INPUT_SHUTDOWN.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn get_global_voice_input_status() -> GlobalVoiceInputStatus {
    GlobalVoiceInputStatus {
        running: GLOBAL_VOICE_INPUT_RUNNING.load(Ordering::SeqCst),
        recording: GLOBAL_VOICE_INPUT_RECORDING.load(Ordering::SeqCst),
    }
}

#[derive(Clone, Serialize)]
pub struct AudioDeviceInfo {
    pub name: String,
    pub device_id: String,
    pub is_default: bool,
}

#[tauri::command]
pub fn get_audio_input_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.description().ok())
        .map(|desc| desc.name().to_string());

    let mut devices = Vec::new();
    match host.input_devices() {
        Ok(device_iter) => {
            for device in device_iter {
                let desc = match device.description() {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                let name = desc.name().to_string();
                let device_id = name.clone();
                let is_default = default_name.as_ref() == Some(&name);
                devices.push(AudioDeviceInfo {
                    name,
                    device_id,
                    is_default,
                });
            }
        }
        Err(e) => return Err(format!("Failed to enumerate input devices: {}", e)),
    }

    Ok(devices)
}

#[tauri::command]
pub fn get_audio_output_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.description().ok())
        .map(|desc| desc.name().to_string());

    let mut devices = Vec::new();
    match host.output_devices() {
        Ok(device_iter) => {
            for device in device_iter {
                let desc = match device.description() {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                let name = desc.name().to_string();
                let device_id = name.clone();
                let is_default = default_name.as_ref() == Some(&name);
                devices.push(AudioDeviceInfo {
                    name,
                    device_id,
                    is_default,
                });
            }
        }
        Err(e) => return Err(format!("Failed to enumerate output devices: {}", e)),
    }

    Ok(devices)
}
