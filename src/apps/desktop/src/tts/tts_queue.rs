const DEBUG_LOG_TTS: bool = false;
macro_rules! debug_print {
    ($($arg:tt)*) => {
        if DEBUG_LOG_TTS {
            eprintln!($($arg)*);
        }
    };
}

use super::TtsEngine;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use tauri::Emitter;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct TtsSegment {
    pub id: u64,
    pub text: String,
    pub voice: String,
    #[serde(default)]
    pub action: String,
    #[serde(default = "default_speaker")]
    pub speaker: String,
}

#[derive(Clone, Serialize, Debug)]
pub struct AudioChunk {
    pub segment_id: u64,
    pub data: String,
    pub sample_rate: u32,
    pub is_last: bool,
}

fn default_speaker() -> String {
    "Serena".to_string()
}

#[derive(Clone, Serialize, Debug)]
pub struct PlaybackStatus {
    pub queue_length: usize,
    pub is_playing: bool,
    pub current_segment_id: Option<u64>,
}

pub struct TtsPlaybackManager {
    queue: Arc<Mutex<VecDeque<TtsSegment>>>,
    engine_tx: Option<Sender<TtsCommand>>,
    running: Arc<AtomicBool>,
    segment_id_counter: AtomicU64,
    current_segment_id: Arc<Mutex<Option<u64>>>,
    worker_handle: Option<JoinHandle<()>>,
}

enum TtsCommand {
    #[allow(dead_code)]
    Segment(TtsSegment),
    Stop,
}

impl TtsPlaybackManager {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            engine_tx: None,
            running: Arc::new(AtomicBool::new(false)),
            segment_id_counter: AtomicU64::new(0),
            current_segment_id: Arc::new(Mutex::new(None)),
            worker_handle: None,
        }
    }

    pub fn push(&self, segment: TtsSegment) {
        let id = segment.id;
        let mut queue = self.queue.lock().unwrap();
        queue.push_back(segment);
        debug_print!("[TtsQ] push: id={}, len={}", id, queue.len());
    }

    pub fn start(&mut self, engine: Arc<Mutex<Option<TtsEngine>>>, app_handle: tauri::AppHandle) {
        eprintln!(
            "[TtsQ] start() called, running={}",
            self.running.load(Ordering::SeqCst)
        );
        if self.running.swap(true, Ordering::SeqCst) {
            debug_print!("[TtsQ] Already running");
            return;
        }

        let queue = self.queue.clone();
        let running = self.running.clone();
        let current_segment_id = self.current_segment_id.clone();

        let (tx, rx): (Sender<TtsCommand>, Receiver<TtsCommand>) = mpsc::channel();
        self.engine_tx = Some(tx);

        let app_handle_inner = app_handle.clone();
        let handle = thread::spawn(move || {
            debug_print!("[TtsQ] Thread starting, sending audio to frontend...");

            while running.load(Ordering::SeqCst) {
                let segment = {
                    let mut q = queue.lock().unwrap();
                    q.pop_front()
                };

                if let Some(seg) = segment {
                    eprintln!(
                        "[TtsQ] Processing: id={}, speaker='{}', text={}",
                        seg.id, seg.speaker, seg.text
                    );

                    {
                        let mut cur = current_segment_id.lock().unwrap();
                        *cur = Some(seg.id);
                    }

                    let _ = app_handle_inner.emit("tts://segment_start", &seg);

                    {
                        let mut guard = engine.lock().unwrap();
                        if let Some(eng) = guard.as_mut() {
                            let requested_speaker = &seg.speaker;
                            eprintln!("[TtsQ] Looking for speaker: '{}'", requested_speaker);
                            let speakers_map = eng.get_speakers_map();
                            eprintln!(
                                "[TtsQ] Available speakers: {:?}",
                                speakers_map.keys().collect::<Vec<_>>()
                            );
                            let voice = eng.get_speaker(requested_speaker).clone();
                            eprintln!(
                                "[TtsQ] Voice loaded: name={:?}, spk_emb_len={}",
                                voice.name,
                                voice.speaker_embedding.len()
                            );

                            let segment_id = seg.id;
                            let app_handle_chunk = app_handle_inner.clone();
                            let app_handle_done = app_handle_inner.clone();
                            let (stream_tx, stream_rx) = std::sync::mpsc::channel::<Vec<f32>>();

                            thread::spawn(move || {
                                while let Ok(samples) = stream_rx.recv() {
                                    let int16_samples: Vec<i16> = samples
                                        .iter()
                                        .map(|&s| (s * 32767.0).clamp(-32768.0, 32767.0) as i16)
                                        .collect();

                                    let bytes: Vec<u8> = int16_samples
                                        .iter()
                                        .flat_map(|&s| s.to_le_bytes())
                                        .collect();

                                    let base64_data = base64::Engine::encode(
                                        &base64::engine::general_purpose::STANDARD,
                                        &bytes,
                                    );

                                    let chunk = AudioChunk {
                                        segment_id,
                                        data: base64_data,
                                        sample_rate: 24000,
                                        is_last: false,
                                    };

                                    let _ = app_handle_chunk.emit("tts://audio_chunk", &chunk);
                                }

                                let final_chunk = AudioChunk {
                                    segment_id,
                                    data: String::new(),
                                    sample_rate: 24000,
                                    is_last: true,
                                };
                                let _ = app_handle_done.emit("tts://audio_chunk", &final_chunk);
                                let _ = app_handle_done.emit("tts://segment_done", &segment_id);
                            });

                            eprintln!(
                                "[TtsQ] Generating audio for segment {}: '{}'",
                                seg.id, seg.text
                            );
                            let instruct = if seg.voice.is_empty() {
                                None
                            } else {
                                Some(seg.voice.as_str())
                            };
                            let result = eng.generate_with_voice_streaming(
                                &seg.text,
                                &voice,
                                instruct,
                                Some(stream_tx),
                            );

                            match &result {
                                Ok(_) => {
                                    eprintln!("[TtsQ] Segment {} generation completed", seg.id);
                                }
                                Err(e) => {
                                    eprintln!("[TtsQueue] Segment {} FAILED: {}", seg.id, e);
                                }
                            }
                        } else {
                            eprintln!(
                                "[TtsQueue] Engine not available for segment {}, SKIPPING!",
                                seg.id
                            );
                        }
                    };

                    {
                        let mut cur = current_segment_id.lock().unwrap();
                        *cur = None;
                    }
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }

                if let Ok(cmd) = rx.try_recv() {
                    match cmd {
                        TtsCommand::Stop => {
                            debug_print!("[TtsQueue] Stop command received");
                            break;
                        }
                        TtsCommand::Segment(s) => {
                            let mut q = queue.lock().unwrap();
                            q.push_front(s);
                        }
                    }
                }
            }

            debug_print!("[TtsQueue] Playback stopped");
            let _ = app_handle_inner.emit("tts://playback_stop", ());
        });

        self.worker_handle = Some(handle);
        let _ = app_handle.emit("tts://playback_start", ());
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(tx) = self.engine_tx.take() {
            let _ = tx.send(TtsCommand::Stop);
        }
        if let Some(handle) = self.worker_handle.take() {
            let _ = handle.join();
        }
        self.clear();
    }

    pub fn clear(&self) {
        let mut queue = self.queue.lock().unwrap();
        queue.clear();
        debug_print!("[TtsQueue] Queue cleared");
    }

    pub fn status(&self) -> PlaybackStatus {
        let queue = self.queue.lock().unwrap();
        let current = self.current_segment_id.lock().unwrap();
        PlaybackStatus {
            queue_length: queue.len(),
            is_playing: self.running.load(Ordering::SeqCst),
            current_segment_id: *current,
        }
    }

    #[allow(dead_code)]
    pub fn next_segment_id(&self) -> u64 {
        self.segment_id_counter.fetch_add(1, Ordering::SeqCst)
    }
}

impl Default for TtsPlaybackManager {
    fn default() -> Self {
        Self::new()
    }
}

static TTS_PLAYBACK_MANAGER: once_cell::sync::Lazy<Mutex<Option<TtsPlaybackManager>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

pub fn get_or_create_manager() -> &'static Mutex<Option<TtsPlaybackManager>> {
    &TTS_PLAYBACK_MANAGER
}
