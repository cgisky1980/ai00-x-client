// C API for Qwen3 ForcedAligner (GGML-backed, GPU-accelerated).
//
// Exposes a simple handle-based interface so Rust can FFI into it without
// pulling in C++ headers. The implementation lives in fa_c_api.cpp and
// wraps the qwen3_asr::ForcedAligner class.
//
// Thread-safety: the returned handle is NOT thread-safe. Call from a single
// thread (the aligner already runs on a blocking thread in Rust).

#pragma once

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

// Export macro: FA_EXPORTS is defined by CMake when building qwen3_fa.dll,
// so FA_API becomes __declspec(dllexport) during build and
// __declspec(dllimport) when consuming the header from another module.
#ifdef _WIN32
  #ifdef FA_EXPORTS
    #define FA_API __declspec(dllexport)
  #else
    #define FA_API __declspec(dllimport)
  #endif
#else
  #define FA_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

// Opaque handle to a ForcedAligner instance.
typedef struct fa_handle fa_handle_t;

// Aligned word: text + start/end time in seconds.
typedef struct fa_word {
    const char * text;   // UTF-8, owned by the library (valid until next call)
    float start;         // seconds
    float end;           // seconds
} fa_word_t;

// Progress callback.
//   stage:   stable short string (e.g. "load_model", "encode_audio", "decode")
//   progress: 0.0 .. 1.0
//   message:  human-readable English description
//   user_data: passed through from fa_align_audio
typedef void (*fa_progress_cb)(const char * stage, float progress, const char * message, void * user_data);

// Alignment result returned by fa_align_audio.
typedef struct fa_result {
    bool success;
    const char * error_msg;  // UTF-8, valid until next call or fa_result_free
    const fa_word_t * words; // array of fa_word_t
    size_t n_words;
    int64_t t_mel_ms;
    int64_t t_encode_ms;
    int64_t t_decode_ms;
    int64_t t_total_ms;
    void * storage;  // opaque, internal use (fa_result_storage)
} fa_result_t;

// Create a new ForcedAligner handle.
// Returns nullptr on failure (check *err_out for message).
//   model_path:  UTF-8 path to the ForcedAligner GGUF file.
//   err_out:     if non-null, set to a static error string on failure.
FA_API fa_handle_t * fa_create(const char * model_path, const char ** err_out);

// Align `text` to the audio at `audio_path`.
// The returned fa_result_t is owned by the caller and must be freed with
// fa_result_free. The handle can be reused for multiple calls.
FA_API fa_result_t fa_align_audio(
    fa_handle_t * handle,
    const char * audio_path,
    const char * text,
    const char * language,
    fa_progress_cb progress_cb,
    void * progress_user_data
);

// Align `text` to in-memory audio samples (32-bit float, mono, 16 kHz).
// This bypasses WAV file parsing entirely — the caller is responsible for
// loading and resampling the audio (e.g. via symphonia in Rust).
//   samples:   pointer to float array (must remain valid for the call duration)
//   n_samples: number of float samples in the array
FA_API fa_result_t fa_align_samples(
    fa_handle_t * handle,
    const float * samples,
    size_t n_samples,
    const char * text,
    const char * language,
    fa_progress_cb progress_cb,
    void * progress_user_data
);

// Free a result returned by fa_align_audio.
FA_API void fa_result_free(fa_result_t * result);

// Destroy a ForcedAligner handle and free all resources.
FA_API void fa_destroy(fa_handle_t * handle);

#ifdef __cplusplus
}
#endif
