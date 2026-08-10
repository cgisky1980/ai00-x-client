// acestep_c.h: C ABI wrapper for acestep.cpp
//
// Exposes the acestep.cpp music generation pipeline through a stable C
// interface so it can be loaded dynamically via libloading from Rust.
//
// All strings passed in are UTF-8, NUL-terminated. Strings returned by
// functions (char*) must be freed with acestep_string_free().
//
// Audio format:
//   - Input  (src_audio/ref_audio): interleaved stereo f32 48kHz [L0,R0,L1,R1,...]
//   - Output (AceStepAudio):        planar stereo f32 48kHz      [L0..LN,R0..RN]
//
// Error handling:
//   Functions return 0 on success, negative on error (-1 generic, -2 cancelled).
//   On error, acestep_last_error() returns a thread-local message.

#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

// Export/import macros for shared library builds.
//   ACESTEP_EXPORTS is defined by CMake when building the .dll/.so.
//   Consumers (Rust) load dynamically via libloading and don't need these.
#if defined(_WIN32)
#  ifdef ACESTEP_EXPORTS
#    define ACESTEP_API __declspec(dllexport)
#  else
#    define ACESTEP_API __declspec(dllimport)
#  endif
#else
#  define ACESTEP_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ---- Opaque handles ---- */

typedef struct AceStepStore AceStepStore;
typedef struct AceStepSynth AceStepSynth;
typedef struct AceStepLm    AceStepLm;

/* ---- Audio output (planar stereo, 48kHz) ---- */

typedef struct AceStepAudio {
    float *   samples;      // [L0..LN, R0..RN] planar, heap-allocated
    int32_t   n_samples;    // per channel
    int32_t   sample_rate;  // always 48000
} AceStepAudio;

/* ---- Callbacks ---- */

// Cancellation callback. Return true to abort the current operation.
typedef bool (*AceStepCancelFn)(void * user_data);

// Progress callback.
//   stage: 0=LM, 1=DiT (denoising), 2=VAE (decode)
//   step:  current step within stage (0-based)
//   total: total steps in this stage
//   msg:   optional human-readable detail (may be NULL)
typedef void (*AceStepProgressFn)(int32_t  stage,
                                  int32_t  step,
                                  int32_t  total,
                                  const char * msg,
                                  void *   user_data);

/* ---- Store ---- */

// Create a model store.
//   keep_loaded = false: EVICT_STRICT (at most one GPU module resident)
//   keep_loaded = true:  EVICT_NEVER  (never evict, accumulate in VRAM)
// Returns NULL on failure.
ACESTEP_API AceStepStore * acestep_store_create(bool keep_loaded);
ACESTEP_API void           acestep_store_free(AceStepStore * store);

/* ---- Synth pipeline ---- */

typedef struct AceStepSynthParams {
    const char * text_encoder_path;  // Qwen3 text encoder GGUF (required)
    const char * dit_path;           // DiT GGUF (required)
    const char * vae_path;           // VAE GGUF (required)
    const char * adapter_path;       // adapter safetensors/dir (NULL = none)
    float        adapter_scale;      // 1.0 default
    bool         use_fa;             // flash attention (default true)
    bool         clamp_fp16;         // clamp hidden states to FP16 range
    bool         use_batch_cfg;      // batch cond+uncond in one DiT forward
    int32_t      vae_chunk;          // latent frames per tile
    int32_t      vae_overlap;        // overlap frames per side
} AceStepSynthParams;

// Fill params with defaults. Strings are set to NULL; caller must set paths.
ACESTEP_API void           acestep_synth_default_params(AceStepSynthParams * params);

// Build a synth context bound to a store. Returns NULL on failure.
ACESTEP_API AceStepSynth * acestep_synth_load(AceStepStore * store, const AceStepSynthParams * params);
ACESTEP_API void           acestep_synth_free(AceStepSynth * synth);

// Full pipeline: DiT denoise + VAE decode in one call.
//
// request_json: single AceRequest as JSON string (see request.h for fields).
// src_audio:    interleaved stereo f32 48kHz for cover/lego/repaint (NULL for text2music).
// src_len:      samples per channel (0 if src_audio is NULL).
// ref_audio:    interleaved stereo f32 48kHz for timbre conditioning (NULL = none).
// ref_len:      samples per channel (0 if ref_audio is NULL).
// out:          caller-allocated struct; samples pointer is set by this function.
//               Caller must free with acestep_audio_free().
//
// Returns: 0 on success, -1 on error, -2 on cancelled.
ACESTEP_API int32_t acestep_synth_generate(
    AceStepSynth *        synth,
    const char *          request_json,
    const float *         src_audio,
    int32_t               src_len,
    const float *         ref_audio,
    int32_t               ref_len,
    AceStepAudio *        out,
    AceStepCancelFn       cancel_fn,
    void *                cancel_data,
    AceStepProgressFn     progress_fn,
    void *                progress_data
);

// Batch variant: generate multiple tracks from a JSON array of requests.
//
// request_json_array: JSON array of AceRequest objects, e.g. "[{...},{...}]".
//   All requests must share the same T (same duration or audio_codes).
// out: caller-allocated array of AceStepAudio[batch_n].
//   batch_n must match the number of requests in the JSON array.
//
// Returns: 0 on success, -1 on error, -2 on cancelled.
ACESTEP_API int32_t acestep_synth_generate_batch(
    AceStepSynth *        synth,
    const char *          request_json_array,
    int32_t               batch_n,
    const float *         src_audio,
    int32_t               src_len,
    const float *         ref_audio,
    int32_t               ref_len,
    AceStepAudio *        out,               // out[batch_n], caller-allocated
    AceStepCancelFn       cancel_fn,
    void *                cancel_data,
    AceStepProgressFn     progress_fn,
    void *                progress_data
);

/* ---- LM pipeline (text -> metadata + lyrics + audio codes) ---- */

typedef struct AceStepLmParams {
    const char * model_path;     // LM GGUF (required)
    int32_t      max_seq;        // KV cache length (0 = default)
    int32_t      max_batch;      // max lm_batch_size for generate
    bool         use_fsm;        // constrained decoding
    bool         use_fa;         // flash attention
    bool         use_batch_cfg;  // batch cond+uncond in one forward
    bool         clamp_fp16;     // clamp hidden states to FP16 range
} AceStepLmParams;

ACESTEP_API void           acestep_lm_default_params(AceStepLmParams * params);
ACESTEP_API AceStepLm *    acestep_lm_load(AceStepStore * store, const AceStepLmParams * params);
ACESTEP_API void           acestep_lm_free(AceStepLm * lm);

// Enrich request via LM. Returns enriched request as a JSON string.
//
// request_json: input AceRequest as JSON.
// lm_batch_size: number of variations to generate (1-9).
// mode: 0=generate (full: metadata+lyrics+codes),
//       1=inspire  (short query -> metadata+lyrics, no codes),
//       2=format   (caption+lyrics -> metadata+lyrics, no codes).
//
// Returns: JSON string (caller must free with acestep_string_free()), or NULL on error.
ACESTEP_API char * acestep_lm_generate(
    AceStepLm *            lm,
    const char *           request_json,
    int32_t                lm_batch_size,
    int32_t                mode,
    AceStepCancelFn        cancel_fn,
    void *                 cancel_data,
    AceStepProgressFn      progress_fn,
    void *                 progress_data
);

/* ---- Audio file I/O ---- */

// Read audio file (WAV or MP3) as interleaved stereo f32 48kHz.
// Returns interleaved buffer (caller must free with acestep_interleaved_free),
// or NULL on error. *out_len receives samples per channel.
ACESTEP_API float * acestep_audio_read_file(const char * path, int32_t * out_len);
ACESTEP_API void    acestep_interleaved_free(float * buf);

// Write planar stereo audio to file.
// format: "mp3", "wav16", "wav24", "wav32".
// mp3_bitrate: kbps for MP3 (ignored for WAV). Use 0 for default 128.
// Returns true on success.
ACESTEP_API bool    acestep_audio_write_file(
    const char *    path,
    const float *   planar_samples,  // [L0..LN, R0..RN]
    int32_t         n_samples,       // per channel
    const char *    format,          // "mp3" / "wav16" / "wav24" / "wav32"
    int32_t         mp3_bitrate
);

// Convert planar stereo [L..,R..] to interleaved [L,R,L,R,...].
// Returns heap buffer (caller frees with acestep_interleaved_free), or NULL.
ACESTEP_API float * acestep_planar_to_interleaved(const float * planar, int32_t n_samples);

// Convert interleaved [L,R,L,R,...] to planar stereo [L..,R..].
// Returns heap buffer (caller frees with acestep_interleaved_free), or NULL.
ACESTEP_API float * acestep_interleaved_to_planar(const float * interleaved, int32_t n_samples);

/* ---- Utilities ---- */

ACESTEP_API void          acestep_audio_free(AceStepAudio * audio);
ACESTEP_API void          acestep_string_free(char * str);
ACESTEP_API const char *  acestep_last_error(void);
ACESTEP_API const char *  acestep_version(void);

#ifdef __cplusplus
}
#endif
