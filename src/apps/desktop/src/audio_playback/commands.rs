use once_cell::sync::Lazy;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::Manager;

use super::channel::ChannelInfo;
use super::mixer::AudioMixer;
use super::sound_library::{SoundCategory, SoundEntry, SoundLibrary};

static AUDIO_MIXER: Lazy<Arc<Mutex<Option<AudioMixer>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));
static SOUND_LIBRARY: Lazy<Arc<Mutex<Option<SoundLibrary>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

#[tauri::command]
pub fn init_audio_mixer() -> Result<(), String> {
    // Check if already initialized
    {
        let guard = AUDIO_MIXER
            .lock()
            .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
        if guard.is_some() {
            log::info!("AudioMixer already initialized, skipping");
            return Ok(());
        }
    }

    let mut guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = AudioMixer::new().map_err(|e| format!("Failed to init AudioMixer: {}", e))?;
    *guard = Some(mixer);
    log::info!("AudioMixer initialized via command");
    Ok(())
}

#[tauri::command]
pub fn init_sound_library(
    sounds_dir: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // Check if already initialized
    {
        let guard = SOUND_LIBRARY
            .lock()
            .map_err(|e| format!("Failed to lock SOUND_LIBRARY: {}", e))?;
        if guard.is_some() {
            log::info!("SoundLibrary already initialized, skipping");
            let dir = guard
                .as_ref()
                .unwrap()
                .sounds_dir()
                .to_string_lossy()
                .to_string();
            return Ok(dir);
        }
    }

    let dir = if let Some(dir) = sounds_dir.filter(|d| !d.is_empty()) {
        std::path::PathBuf::from(dir)
    } else {
        // Auto-resolve: try multiple strategies
        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        let res_sounds = resource_dir.join("sounds");
        if res_sounds.exists() {
            log::info!("SoundLibrary: using resource dir: {:?}", res_sounds);
            res_sounds
        } else {
            // Dev mode: use CARGO_MANIFEST_DIR or relative paths from exe
            let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
                .map(|d| std::path::PathBuf::from(d).join("sounds"))
                .ok();

            let exe_dir = std::env::current_exe()
                .map_err(|e| format!("Failed to get exe path: {}", e))?
                .parent()
                .ok_or_else(|| "No parent dir".to_string())?
                .to_path_buf();

            let candidates: Vec<std::path::PathBuf> = vec![
                // CARGO_MANIFEST_DIR/sounds (dev mode)
                manifest_dir,
                // exe_dir/../../../src/apps/desktop/sounds
                Some(exe_dir.join("../../../src/apps/desktop/sounds")),
                // exe_dir/../../src/apps/desktop/sounds
                Some(exe_dir.join("../../src/apps/desktop/sounds")),
                // exe_dir/sounds
                Some(exe_dir.join("sounds")),
            ]
            .into_iter()
            .flatten()
            .collect();

            let found = candidates
                .iter()
                .find(|p| p.exists())
                .cloned()
                .unwrap_or_else(|| res_sounds.clone());

            log::info!("SoundLibrary: candidates tried: {:?}", candidates);
            log::info!("SoundLibrary: using dir: {:?}", found);
            found
        }
    };

    let dir_str = dir.to_string_lossy().to_string();
    let mut guard = SOUND_LIBRARY
        .lock()
        .map_err(|e| format!("Failed to lock SOUND_LIBRARY: {}", e))?;
    let lib = SoundLibrary::new(dir).map_err(|e| format!("Failed to init SoundLibrary: {}", e))?;
    *guard = Some(lib);
    log::info!("SoundLibrary initialized at: {}", dir_str);
    Ok(dir_str)
}

#[tauri::command]
pub fn audio_play_bgm(
    path: String,
    volume: f32,
    fade_in_secs: f32,
    loop_enabled: bool,
) -> Result<u64, String> {
    log::info!(
        "[AudioCmd] audio_play_bgm: path={}, volume={}, fade_in={}, loop={}",
        path,
        volume,
        fade_in_secs,
        loop_enabled
    );
    // CPU-intensive decode + resample BEFORE acquiring any lock
    let output_sr = {
        let guard = AUDIO_MIXER
            .lock()
            .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
        let mixer = guard
            .as_ref()
            .ok_or_else(|| "AudioMixer not initialized".to_string())?;
        mixer.output_sample_rate()
    };
    let (samples, ch) =
        AudioMixer::load_and_resample(&path, output_sr).map_err(|e| format!("{}", e))?;

    // Now acquire lock only for lightweight channel operations
    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    mixer
        .play_bgm_with_samples(&path, volume, fade_in_secs, loop_enabled, samples, ch)
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
pub fn audio_play_sfx(path: String, volume: f32) -> Result<u64, String> {
    // CPU-intensive decode + resample BEFORE acquiring any lock
    let output_sr = {
        let guard = AUDIO_MIXER
            .lock()
            .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
        let mixer = guard
            .as_ref()
            .ok_or_else(|| "AudioMixer not initialized".to_string())?;
        mixer.output_sample_rate()
    };
    let (samples, ch) =
        AudioMixer::load_and_resample(&path, output_sr).map_err(|e| format!("{}", e))?;

    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    mixer
        .play_sfx_with_samples(&path, volume, samples, ch)
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
pub fn audio_play_preview(path: String, volume: f32) -> Result<u64, String> {
    // CPU-intensive decode + resample BEFORE acquiring any lock
    let output_sr = {
        let guard = AUDIO_MIXER
            .lock()
            .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
        let mixer = guard
            .as_ref()
            .ok_or_else(|| "AudioMixer not initialized".to_string())?;
        mixer.output_sample_rate()
    };
    let (samples, ch) =
        AudioMixer::load_and_resample(&path, output_sr).map_err(|e| format!("{}", e))?;

    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    mixer
        .play_preview_with_samples(&path, volume, samples, ch)
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
pub fn audio_stop_channel(id: u64, fade_out_secs: f32) -> Result<(), String> {
    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    mixer.stop_channel(id, fade_out_secs);
    Ok(())
}

#[tauri::command]
pub fn audio_stop_all_sfx() -> Result<(), String> {
    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    mixer.stop_all_sfx();
    Ok(())
}

#[tauri::command]
pub fn audio_stop_preview() -> Result<(), String> {
    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    mixer.stop_preview();
    Ok(())
}

#[tauri::command]
pub fn audio_set_channel_volume(id: u64, volume: f32) -> Result<(), String> {
    log::info!(
        "[AudioCmd] set_channel_volume: id={}, volume={}",
        id,
        volume
    );
    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    mixer
        .set_channel_volume(id, volume)
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
pub fn audio_set_master_volume(volume: f32) -> Result<(), String> {
    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    mixer.set_master_volume(volume);
    Ok(())
}

#[tauri::command]
pub fn audio_get_master_volume() -> Result<f32, String> {
    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    Ok(mixer.get_master_volume())
}

#[tauri::command]
pub fn audio_get_spectrum() -> Result<Vec<f32>, String> {
    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    Ok(mixer.get_spectrum())
}

#[tauri::command]
pub fn audio_pause_channel(id: u64) -> Result<(), String> {
    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    mixer.pause_channel(id).map_err(|e| format!("{}", e))
}

#[tauri::command]
pub fn audio_resume_channel(id: u64) -> Result<(), String> {
    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    mixer.resume_channel(id).map_err(|e| format!("{}", e))
}

#[tauri::command]
pub fn audio_seek_channel(id: u64, position_secs: f32) -> Result<(), String> {
    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    mixer
        .seek_channel(id, position_secs)
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
pub fn audio_list_channels() -> Result<Vec<ChannelInfo>, String> {
    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    // List channels BEFORE cleanup so JS can see Stopped state transitions
    let channels = mixer.list_channels();
    // Clean up stopped channels periodically to prevent memory leak
    mixer.cleanup_stopped();
    Ok(channels)
}

#[tauri::command]
pub fn sound_library_list() -> Result<Vec<SoundCategory>, String> {
    let guard = SOUND_LIBRARY
        .lock()
        .map_err(|e| format!("Failed to lock SOUND_LIBRARY: {}", e))?;
    let lib = guard
        .as_ref()
        .ok_or_else(|| "SoundLibrary not initialized".to_string())?;
    Ok(lib.list_categories())
}

#[tauri::command]
pub fn sound_library_play(id: String, volume: f32) -> Result<u64, String> {
    // Get path from library
    let path = {
        let guard = SOUND_LIBRARY
            .lock()
            .map_err(|e| format!("Failed to lock SOUND_LIBRARY: {}", e))?;
        let lib = guard
            .as_ref()
            .ok_or_else(|| "SoundLibrary not initialized".to_string())?;
        let p = lib
            .get_sound_path(&id)
            .ok_or_else(|| format!("Sound '{}' not found", id))?;
        log::info!("Sound '{}' resolved to path: {:?}", id, p);
        if !p.exists() {
            return Err(format!("Sound file does not exist: {:?}", p));
        }
        p
    };

    let path_str = path.to_string_lossy().to_string();

    // CPU-intensive decode + resample BEFORE acquiring AUDIO_MIXER lock
    let output_sr = {
        let guard = AUDIO_MIXER
            .lock()
            .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
        let mixer = guard
            .as_ref()
            .ok_or_else(|| "AudioMixer not initialized".to_string())?;
        mixer.output_sample_rate()
    };
    let (samples, ch) =
        AudioMixer::load_and_resample(&path_str, output_sr).map_err(|e| format!("{}", e))?;

    let guard = AUDIO_MIXER
        .lock()
        .map_err(|e| format!("Failed to lock AUDIO_MIXER: {}", e))?;
    let mixer = guard
        .as_ref()
        .ok_or_else(|| "AudioMixer not initialized".to_string())?;
    let result = mixer.play_sfx_with_samples(&path_str, volume, samples, ch);
    log::info!(
        "SFX play result for '{}': {:?}",
        id,
        result.as_ref().map(|_| "ok")
    );
    result.map_err(|e| format!("{}", e))
}

#[tauri::command]
pub fn sound_library_save(
    source_path: String,
    category: String,
    name: String,
    prompt: String,
) -> Result<SoundEntry, String> {
    let mut guard = SOUND_LIBRARY
        .lock()
        .map_err(|e| format!("Failed to lock SOUND_LIBRARY: {}", e))?;
    let lib = guard
        .as_mut()
        .ok_or_else(|| "SoundLibrary not initialized".to_string())?;
    lib.save_to_library(&source_path, &category, &name, &prompt)
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
pub fn sound_library_delete(id: String) -> Result<(), String> {
    let mut guard = SOUND_LIBRARY
        .lock()
        .map_err(|e| format!("Failed to lock SOUND_LIBRARY: {}", e))?;
    let lib = guard
        .as_mut()
        .ok_or_else(|| "SoundLibrary not initialized".to_string())?;
    lib.delete_sound(&id).map_err(|e| format!("{}", e))
}

/// Check if any audio channel is currently playing.
/// Used by audio generation to decide GPU vs CPU backend.
pub fn is_audio_playing() -> bool {
    let guard = match AUDIO_MIXER.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    match guard.as_ref() {
        Some(mixer) => mixer.is_any_playing(),
        None => false,
    }
}

/// Delete a generated audio temp file from disk.
#[tauri::command]
pub fn delete_audio_file(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("Failed to delete file: {}", e))?;
        log::info!("[AudioCmd] Deleted audio file: {}", file_path);
    }
    Ok(())
}
