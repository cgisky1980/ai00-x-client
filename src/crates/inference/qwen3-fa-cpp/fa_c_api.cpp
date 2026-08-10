// C API wrapper for qwen3_asr::ForcedAligner.
//
// Drives the full ForcedAligner::align() pipeline and reports coarse progress.
// Granular per-stage progress would require making private methods public;
// for now we emit start/done plus a single "running" event.

#include "fa_c_api.h"
#include "forced_aligner.h"

#include <cstdio>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
// OutputDebugStringA prints to the Visual Studio Output window and is also
// captured by the Tauri terminal. We use it as a simple cross-process logger.
#define FA_LOG(msg) do { \
    fprintf(stderr, "[FA-C] %s\n", msg); \
    fflush(stderr); \
    OutputDebugStringA("[FA-C] " msg "\n"); \
} while (0)
#define FA_LOGF(fmt, ...) do { \
    fprintf(stderr, "[FA-C] " fmt "\n", __VA_ARGS__); \
    fflush(stderr); \
    char _buf[512]; \
    snprintf(_buf, sizeof(_buf), "[FA-C] " fmt "\n", __VA_ARGS__); \
    OutputDebugStringA(_buf); \
} while (0)
#else
#define FA_LOG(msg) do { fprintf(stderr, "[FA-C] %s\n", msg); fflush(stderr); } while (0)
#define FA_LOGF(fmt, ...) do { fprintf(stderr, "[FA-C] " fmt "\n", __VA_ARGS__); fflush(stderr); } while (0)
#endif

struct fa_handle {
    qwen3_asr::ForcedAligner aligner;
};

// Storage for result data — kept alive until fa_result_free.
// We stash this in the result's opaque storage field.
struct fa_result_storage {
    std::vector<fa_word_t> words_c;
    std::vector<std::string> word_texts;  // keeps string data alive
};

extern "C" {

FA_API fa_handle_t * fa_create(const char * model_path, const char ** err_out) {
    FA_LOGF("fa_create: model_path=%s", model_path ? model_path : "(null)");
    auto * h = new fa_handle;
    FA_LOG("fa_create: calling load_model...");
    if (!h->aligner.load_model(model_path)) {
        static thread_local std::string last_err;
        last_err = h->aligner.get_error();
        FA_LOGF("fa_create: load_model FAILED: %s", last_err.c_str());
        if (err_out) *err_out = last_err.c_str();
        delete h;
        return nullptr;
    }
    FA_LOG("fa_create: load_model OK");
    return h;
}

FA_API fa_result_t fa_align_audio(
    fa_handle_t * handle,
    const char * audio_path,
    const char * text,
    const char * language,
    fa_progress_cb progress_cb,
    void * progress_user_data
) {
    fa_result_t result = {};
    result.success = false;

    FA_LOGF("fa_align_audio: audio=%s, text_len=%zu, lang=%s",
            audio_path ? audio_path : "(null)",
            text ? strlen(text) : 0,
            language ? language : "(null)");

    if (!handle) {
        result.error_msg = "null handle";
        return result;
    }

    if (progress_cb) {
        progress_cb("start", 0.0f, "Starting alignment", progress_user_data);
        progress_cb("running", 0.1f, "Running full pipeline (mel + encoder + decoder, GPU-accelerated)", progress_user_data);
    }

    FA_LOG("fa_align_audio: calling aligner.align()...");
    auto aligned = handle->aligner.align(
        std::string(audio_path),
        std::string(text),
        language ? std::string(language) : std::string()
    );
    FA_LOGF("fa_align_audio: align() returned, success=%d, words=%zu",
            (int)aligned.success, aligned.words.size());

    if (!aligned.success) {
        // Error string is inside `aligned`; copy to a static buffer.
        static thread_local std::string err_copy;
        err_copy = aligned.error_msg;
        result.error_msg = err_copy.c_str();
        if (progress_cb) progress_cb("error", 0.0f, err_copy.c_str(), progress_user_data);
        return result;
    }

    // Copy words into stable storage.
    // IMPORTANT: fill word_texts FIRST, then build words_c. If we interleave
    // push_back into word_texts with c_str() pointer extraction, a vector
    // reallocation inside word_texts invalidates every previously-stored
    // c_str() pointer — producing dangling pointers that read as "" or garbage.
    auto * storage = new fa_result_storage;
    storage->word_texts.reserve(aligned.words.size());
    for (const auto & w : aligned.words) {
        storage->word_texts.push_back(w.word);
    }
    storage->words_c.reserve(aligned.words.size());
    for (size_t i = 0; i < storage->word_texts.size(); ++i) {
        fa_word_t cw;
        cw.text = storage->word_texts[i].c_str();
        cw.start = aligned.words[i].start;
        cw.end = aligned.words[i].end;
        storage->words_c.push_back(cw);
    }

    result.success = true;
    result.error_msg = nullptr;
    result.words = storage->words_c.data();
    result.n_words = storage->words_c.size();
    result.t_mel_ms = aligned.t_mel_ms;
    result.t_encode_ms = aligned.t_encode_ms;
    result.t_decode_ms = aligned.t_decode_ms;
    result.t_total_ms = aligned.t_total_ms;
    result.storage = storage;

    if (progress_cb) {
        char timing_msg[256];
        snprintf(timing_msg, sizeof(timing_msg),
                 "Done (mel=%lldms, encode=%lldms, decode=%lldms, total=%lldms)",
                 (long long)aligned.t_mel_ms, (long long)aligned.t_encode_ms,
                 (long long)aligned.t_decode_ms, (long long)aligned.t_total_ms);
        progress_cb("done", 1.0f, timing_msg, progress_user_data);
    }
    return result;
}

FA_API fa_result_t fa_align_samples(
    fa_handle_t * handle,
    const float * samples,
    size_t n_samples,
    const char * text,
    const char * language,
    fa_progress_cb progress_cb,
    void * progress_user_data
) {
    fa_result_t result = {};
    result.success = false;

    FA_LOGF("fa_align_samples: n_samples=%zu, text_len=%zu, lang=%s",
            n_samples,
            text ? strlen(text) : 0,
            language ? language : "(null)");

    if (!handle) {
        result.error_msg = "null handle";
        return result;
    }
    if (!samples || n_samples == 0) {
        result.error_msg = "no audio samples provided";
        return result;
    }

    if (progress_cb) {
        progress_cb("start", 0.0f, "Starting alignment", progress_user_data);
        progress_cb("running", 0.1f, "Running full pipeline (mel + encoder + decoder, GPU-accelerated)", progress_user_data);
    }

    FA_LOG("fa_align_samples: calling aligner.align(samples)...");
    auto aligned = handle->aligner.align(
        samples,
        static_cast<int>(n_samples),
        std::string(text),
        language ? std::string(language) : std::string()
    );
    FA_LOGF("fa_align_samples: align() returned, success=%d, words=%zu",
            (int)aligned.success, aligned.words.size());

    if (!aligned.success) {
        static thread_local std::string err_copy;
        err_copy = aligned.error_msg;
        result.error_msg = err_copy.c_str();
        if (progress_cb) progress_cb("error", 0.0f, err_copy.c_str(), progress_user_data);
        return result;
    }

    auto * storage = new fa_result_storage;
    // Fill word_texts FIRST (see fa_align_audio for the dangling-pointer
    // explanation), then build words_c from stable c_str() pointers.
    storage->word_texts.reserve(aligned.words.size());
    for (const auto & w : aligned.words) {
        storage->word_texts.push_back(w.word);
    }
    storage->words_c.reserve(aligned.words.size());
    for (size_t i = 0; i < storage->word_texts.size(); ++i) {
        fa_word_t cw;
        cw.text = storage->word_texts[i].c_str();
        cw.start = aligned.words[i].start;
        cw.end = aligned.words[i].end;
        storage->words_c.push_back(cw);
    }

    result.success = true;
    result.error_msg = nullptr;
    result.words = storage->words_c.data();
    result.n_words = storage->words_c.size();
    result.t_mel_ms = aligned.t_mel_ms;
    result.t_encode_ms = aligned.t_encode_ms;
    result.t_decode_ms = aligned.t_decode_ms;
    result.t_total_ms = aligned.t_total_ms;
    result.storage = storage;

    if (progress_cb) {
        char timing_msg[256];
        snprintf(timing_msg, sizeof(timing_msg),
                 "Done (mel=%lldms, encode=%lldms, decode=%lldms, total=%lldms)",
                 (long long)aligned.t_mel_ms, (long long)aligned.t_encode_ms,
                 (long long)aligned.t_decode_ms, (long long)aligned.t_total_ms);
        progress_cb("done", 1.0f, timing_msg, progress_user_data);
    }
    return result;
}

FA_API void fa_result_free(fa_result_t * result) {
    if (!result) return;
    if (result->storage) {
        delete static_cast<fa_result_storage *>(result->storage);
        result->storage = nullptr;
        result->words = nullptr;
        result->n_words = 0;
    }
    // error_msg points to thread_local static, no free needed.
    result->error_msg = nullptr;
}

FA_API void fa_destroy(fa_handle_t * handle) {
    delete handle;
}

}  // extern "C"
