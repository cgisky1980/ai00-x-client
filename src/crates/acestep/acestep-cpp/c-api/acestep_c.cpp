// acestep_c.cpp: C ABI wrapper implementation for acestep.cpp
//
// Bridges the stable C interface (acestep_c.h) to the C++ acestep.cpp API.
// String paths are copied into wrapper structs to keep them alive for the
// lifetime of the contexts (the C++ params store raw const char* pointers).

#include "acestep_c.h"

#include "audio-io.h"
#include "model-store.h"
#include "pipeline-lm.h"
#include "pipeline-synth.h"
#include "pipeline-synth-impl.h"  // AceSynth full definition (for is_turbo access)
#include "request.h"
#include "task-types.h"
#include "version.h"

#include <cstdarg>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// Verify AceStepAudio (C ABI) is layout-compatible with AceAudio (C++).
// Both must be POD with identical field sizes and offsets.
static_assert(sizeof(AceStepAudio) == sizeof(AceAudio),
              "AceStepAudio and AceAudio must have the same size");
static_assert(offsetof(AceStepAudio, samples) == offsetof(AceAudio, samples),
              "samples field offset mismatch");
static_assert(offsetof(AceStepAudio, n_samples) == offsetof(AceAudio, n_samples),
              "n_samples field offset mismatch");
static_assert(offsetof(AceStepAudio, sample_rate) == offsetof(AceAudio, sample_rate),
              "sample_rate field offset mismatch");

// ---- Thread-local error ----

static thread_local std::string g_last_error;

static void set_error(const char * fmt, ...) {
    va_list args;
    va_start(args, fmt);
    char buf[1024];
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    g_last_error = buf;
}

static void set_error_str(const std::string & msg) {
    g_last_error = msg;
}

extern "C" const char * acestep_last_error(void) {
    return g_last_error.c_str();
}

extern "C" const char * acestep_version(void) {
    return ACE_VERSION;
}

// ---- Wrapper structs (keep string copies alive) ----

struct AceStepStore {
    ModelStore * store;
};

struct AceStepSynth {
    AceSynth *   ctx;
    std::string  text_encoder_path;
    std::string  dit_path;
    std::string  vae_path;
    std::string  adapter_path;
};

struct AceStepLm {
    AceLm *      ctx;
    std::string  model_path;
};

// ---- Cancel callback bridge ----
// The C++ cancel callback signature is identical to our C callback,
// so we can pass through directly. No wrapper needed.

// ---- Progress helper (calls C callback if set) ----

static void emit_progress(AceStepProgressFn fn, void * data,
                          int32_t stage, int32_t step, int32_t total,
                          const char * msg) {
    if (fn) {
        fn(stage, step, total, msg, data);
    }
}

// ---- Progress-aware cancel wrapper ----
// DiT sampler polls the cancel callback at the start of every denoising step.
// We wrap it to also emit a progress event per step, so the UI gets real-time
// "DiT step 3/50" updates instead of just "0/0 → 1/1".

struct ProgressCancelCtx {
    AceStepCancelFn   cancel_fn;      // original cancel function (may be NULL)
    void *            cancel_data;    // original cancel data
    AceStepProgressFn progress_fn;    // progress callback (may be NULL)
    void *            progress_data;  // progress data
    int               num_steps;      // total DiT steps
    int               current_step;   // step counter (incremented per call)
};

static bool progress_cancel_wrapper(void * user_data) {
    ProgressCancelCtx * ctx = static_cast<ProgressCancelCtx *>(user_data);
    if (!ctx) return false;

    // Emit progress for the step about to run.
    if (ctx->progress_fn && ctx->num_steps > 0) {
        char msg[64];
        snprintf(msg, sizeof(msg), "DiT step %d/%d", ctx->current_step + 1, ctx->num_steps);
        ctx->progress_fn(1, ctx->current_step + 1, ctx->num_steps, msg, ctx->progress_data);
    }
    ctx->current_step++;

    // Delegate to original cancel check.
    if (ctx->cancel_fn) {
        return ctx->cancel_fn(ctx->cancel_data);
    }
    return false;
}

// =====================================================================
// Store
// =====================================================================

extern "C" AceStepStore * acestep_store_create(bool keep_loaded) {
    EvictPolicy policy = keep_loaded ? EVICT_NEVER : EVICT_STRICT;
    ModelStore * store = store_create(policy);
    if (!store) {
        set_error("Failed to create model store");
        return NULL;
    }
    AceStepStore * wrapper = new AceStepStore();
    wrapper->store         = store;
    return wrapper;
}

extern "C" void acestep_store_free(AceStepStore * store) {
    if (!store) return;
    if (store->store) {
        store_free(store->store);
    }
    delete store;
}

// =====================================================================
// Synth pipeline
// =====================================================================

extern "C" void acestep_synth_default_params(AceStepSynthParams * params) {
    if (!params) return;
    AceSynthParams defaults;
    ace_synth_default_params(&defaults);

    params->text_encoder_path = NULL;
    params->dit_path          = NULL;
    params->vae_path          = NULL;
    params->adapter_path      = NULL;
    params->adapter_scale     = defaults.adapter_scale;
    params->use_fa            = defaults.use_fa;
    params->clamp_fp16        = defaults.clamp_fp16;
    params->use_batch_cfg     = defaults.use_batch_cfg;
    params->vae_chunk         = defaults.vae_chunk;
    params->vae_overlap       = defaults.vae_overlap;
}

extern "C" AceStepSynth * acestep_synth_load(AceStepStore * store,
                                              const AceStepSynthParams * params) {
    if (!store || !store->store) {
        set_error("Store is NULL or invalid");
        return NULL;
    }
    if (!params) {
        set_error("Params is NULL");
        return NULL;
    }
    if (!params->dit_path || !params->text_encoder_path || !params->vae_path) {
        set_error("dit_path, text_encoder_path and vae_path are all required");
        return NULL;
    }

    AceStepSynth * wrapper = new AceStepSynth();
    wrapper->text_encoder_path = params->text_encoder_path;
    wrapper->dit_path          = params->dit_path;
    wrapper->vae_path          = params->vae_path;
    if (params->adapter_path) {
        wrapper->adapter_path = params->adapter_path;
    }

    // Build C++ params pointing to our owned strings
    AceSynthParams cpp_params;
    ace_synth_default_params(&cpp_params);
    cpp_params.text_encoder_path = wrapper->text_encoder_path.c_str();
    cpp_params.dit_path          = wrapper->dit_path.c_str();
    cpp_params.vae_path          = wrapper->vae_path.c_str();
    cpp_params.adapter_path      = wrapper->adapter_path.empty() ? NULL : wrapper->adapter_path.c_str();
    cpp_params.adapter_scale     = params->adapter_scale;
    cpp_params.use_fa            = params->use_fa;
    cpp_params.clamp_fp16        = params->clamp_fp16;
    cpp_params.use_batch_cfg     = params->use_batch_cfg;
    cpp_params.vae_chunk         = params->vae_chunk;
    cpp_params.vae_overlap       = params->vae_overlap;
    cpp_params.dump_dir          = NULL;

    wrapper->ctx = ace_synth_load(store->store, &cpp_params);
    if (!wrapper->ctx) {
        set_error("ace_synth_load failed (check model paths and GGUF files)");
        delete wrapper;
        return NULL;
    }

    return wrapper;
}

extern "C" void acestep_synth_free(AceStepSynth * synth) {
    if (!synth) return;
    if (synth->ctx) {
        ace_synth_free(synth->ctx);
    }
    delete synth;
}

// Internal: run synth pipeline for a batch of requests.
// Parses JSON, runs DiT + VAE, fills out[].
// Returns 0 on success, -1 on error, -2 on cancelled.
static int32_t synth_run_internal(
    AceStepSynth *        synth,
    const char *          request_json,
    int32_t               batch_n,
    const float *         src_audio,
    int32_t               src_len,
    const float *         ref_audio,
    int32_t               ref_len,
    AceStepAudio *        out,
    AceStepCancelFn       cancel_fn,
    void *                cancel_data,
    AceStepProgressFn     progress_fn,
    void *                progress_data
) {
    if (!synth || !synth->ctx) {
        set_error("Synth context is NULL or invalid");
        return -1;
    }
    if (!request_json) {
        set_error("request_json is NULL");
        return -1;
    }
    if (batch_n < 1 || batch_n > 9) {
        set_error("batch_n must be 1..9, got %d", batch_n);
        return -1;
    }

    // Parse JSON into AceRequest array
    std::vector<AceRequest> reqs(batch_n);
    if (batch_n == 1) {
        if (!request_parse_json(&reqs[0], request_json)) {
            set_error("Failed to parse request JSON: %s", request_json);
            return -1;
        }
    } else {
        std::vector<AceRequest> parsed;
        if (!request_parse_json_array(request_json, &parsed)) {
            set_error("Failed to parse request JSON array");
            return -1;
        }
        if ((int32_t) parsed.size() != batch_n) {
            set_error("JSON array has %zu requests but batch_n=%d", parsed.size(), batch_n);
            return -1;
        }
        reqs = std::move(parsed);
    }

    // Resolve seeds
    for (int i = 0; i < batch_n; i++) {
        request_resolve_seed(&reqs[i]);
    }

    // Phase 1: DiT denoising
    // Determine the actual number of DiT steps for progress reporting.
    // inference_steps=0 means auto (turbo: 8, sft: 50).
    int dit_num_steps = reqs[0].inference_steps;
    if (dit_num_steps <= 0) {
        dit_num_steps = synth->ctx->meta->is_turbo ? 8 : 50;
    }
    if (dit_num_steps > 100) {
        dit_num_steps = 100;
    }

    emit_progress(progress_fn, progress_data, 1, 0, dit_num_steps, "DiT denoising started");

    // Wrap cancel callback to also emit per-step progress events.
    // The DiT sampler polls cancel at the start of every step, so the wrapper
    // sends "DiT step N/M" before each denoising step.
    ProgressCancelCtx pc_ctx;
    pc_ctx.cancel_fn      = cancel_fn;
    pc_ctx.cancel_data    = cancel_data;
    pc_ctx.progress_fn    = progress_fn;
    pc_ctx.progress_data  = progress_data;
    pc_ctx.num_steps      = dit_num_steps;
    pc_ctx.current_step   = 0;

    AceSynthJob * job = ace_synth_job_run_dit(
        synth->ctx,
        reqs.data(),
        src_audio, src_len,
        NULL, 0,           // src_latents (not used, using audio)
        ref_audio, ref_len,
        NULL, 0,           // ref_latents (not used, using audio)
        batch_n,
        progress_cancel_wrapper,
        &pc_ctx
    );

    if (!job) {
        // Could be error or cancellation. Check via original callback.
        if (cancel_fn && cancel_fn(cancel_data)) {
            set_error("DiT phase cancelled");
            return -2;
        }
        set_error("DiT phase failed");
        return -1;
    }

    emit_progress(progress_fn, progress_data, 1, dit_num_steps, dit_num_steps, "DiT denoising complete");

    // Phase 2: VAE decode (use original cancel, no progress wrapper needed)
    emit_progress(progress_fn, progress_data, 2, 0, 0, "VAE decode started");

    // AceAudio is layout-compatible with AceStepAudio (same fields, same types)
    int32_t rc = ace_synth_job_run_vae(
        synth->ctx,
        job,
        reinterpret_cast<AceAudio *>(out),
        cancel_fn,
        cancel_data
    );

    ace_synth_job_free(job);

    if (rc != 0) {
        if (cancel_fn && cancel_fn(cancel_data)) {
            set_error("VAE phase cancelled");
            return -2;
        }
        set_error("VAE phase failed");
        return -1;
    }

    emit_progress(progress_fn, progress_data, 2, 1, 1, "VAE decode complete");
    return 0;
}

extern "C" int32_t acestep_synth_generate(
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
) {
    if (!out) {
        set_error("out is NULL");
        return -1;
    }
    // Zero the output struct so cleanup is safe
    out->samples      = NULL;
    out->n_samples    = 0;
    out->sample_rate  = 48000;

    return synth_run_internal(synth, request_json, 1,
                              src_audio, src_len,
                              ref_audio, ref_len,
                              out,
                              cancel_fn, cancel_data,
                              progress_fn, progress_data);
}

extern "C" int32_t acestep_synth_generate_batch(
    AceStepSynth *        synth,
    const char *          request_json_array,
    int32_t               batch_n,
    const float *         src_audio,
    int32_t               src_len,
    const float *         ref_audio,
    int32_t               ref_len,
    AceStepAudio *        out,
    AceStepCancelFn       cancel_fn,
    void *                cancel_data,
    AceStepProgressFn     progress_fn,
    void *                progress_data
) {
    if (!out) {
        set_error("out is NULL");
        return -1;
    }
    // Zero all output structs
    for (int i = 0; i < batch_n; i++) {
        out[i].samples      = NULL;
        out[i].n_samples    = 0;
        out[i].sample_rate  = 48000;
    }

    return synth_run_internal(synth, request_json_array, batch_n,
                              src_audio, src_len,
                              ref_audio, ref_len,
                              out,
                              cancel_fn, cancel_data,
                              progress_fn, progress_data);
}

// =====================================================================
// LM pipeline
// =====================================================================

extern "C" void acestep_lm_default_params(AceStepLmParams * params) {
    if (!params) return;
    AceLmParams defaults;
    ace_lm_default_params(&defaults);

    params->model_path    = NULL;
    params->max_seq       = defaults.max_seq;
    params->max_batch     = defaults.max_batch;
    params->use_fsm       = defaults.use_fsm;
    params->use_fa        = defaults.use_fa;
    params->use_batch_cfg = defaults.use_batch_cfg;
    params->clamp_fp16    = defaults.clamp_fp16;
}

extern "C" AceStepLm * acestep_lm_load(AceStepStore * store,
                                        const AceStepLmParams * params) {
    if (!store || !store->store) {
        set_error("Store is NULL or invalid");
        return NULL;
    }
    if (!params || !params->model_path) {
        set_error("model_path is required");
        return NULL;
    }

    AceStepLm * wrapper = new AceStepLm();
    wrapper->model_path = params->model_path;

    AceLmParams cpp_params;
    ace_lm_default_params(&cpp_params);
    cpp_params.model_path    = wrapper->model_path.c_str();
    cpp_params.max_seq       = params->max_seq > 0 ? params->max_seq : 8192;
    cpp_params.max_batch     = params->max_batch > 0 ? params->max_batch : 1;
    cpp_params.use_fsm       = params->use_fsm;
    cpp_params.use_fa        = params->use_fa;
    cpp_params.use_batch_cfg = params->use_batch_cfg;
    cpp_params.clamp_fp16    = params->clamp_fp16;

    wrapper->ctx = ace_lm_load(store->store, &cpp_params);
    if (!wrapper->ctx) {
        set_error("ace_lm_load failed (check LM model path)");
        delete wrapper;
        return NULL;
    }

    return wrapper;
}

extern "C" void acestep_lm_free(AceStepLm * lm) {
    if (!lm) return;
    if (lm->ctx) {
        ace_lm_free(lm->ctx);
    }
    delete lm;
}

extern "C" char * acestep_lm_generate(
    AceStepLm *            lm,
    const char *           request_json,
    int32_t                lm_batch_size,
    int32_t                mode,
    AceStepCancelFn        cancel_fn,
    void *                 cancel_data,
    AceStepProgressFn      progress_fn,
    void *                 progress_data
) {
    if (!lm || !lm->ctx) {
        set_error("LM context is NULL or invalid");
        return NULL;
    }
    if (!request_json) {
        set_error("request_json is NULL");
        return NULL;
    }
    if (lm_batch_size < 1 || lm_batch_size > 9) {
        set_error("lm_batch_size must be 1..9, got %d", lm_batch_size);
        return NULL;
    }
    if (mode < 0 || mode > 2) {
        set_error("mode must be 0 (generate), 1 (inspire), or 2 (format)");
        return NULL;
    }

    // Parse input request
    AceRequest req;
    request_init(&req);
    if (!request_parse_json(&req, request_json)) {
        set_error("Failed to parse request JSON: %s", request_json);
        return NULL;
    }

    // Allocate output array
    std::vector<AceRequest> out_reqs(lm_batch_size);
    for (int i = 0; i < lm_batch_size; i++) {
        request_init(&out_reqs[i]);
    }

    emit_progress(progress_fn, progress_data, 0, 0, 0, "LM generation started");

    // Run LM generation
    int rc = ace_lm_generate(
        lm->ctx,
        &req,
        lm_batch_size,
        out_reqs.data(),
        NULL,   // dump_logits
        NULL,   // dump_tokens
        cancel_fn,
        cancel_data,
        mode
    );

    if (rc != 0) {
        if (cancel_fn && cancel_fn(cancel_data)) {
            set_error("LM generation cancelled");
        } else {
            set_error("LM generation failed");
        }
        return NULL;
    }

    emit_progress(progress_fn, progress_data, 0, 1, 1, "LM generation complete");

    // Serialize first result as JSON (the most common use case)
    // For batch_size > 1, we return a JSON array
    std::string result_json;
    if (lm_batch_size == 1) {
        result_json = request_to_json(&out_reqs[0], true);
    } else {
        result_json = "[";
        for (int i = 0; i < lm_batch_size; i++) {
            if (i > 0) result_json += ",";
            result_json += request_to_json(&out_reqs[i], true);
        }
        result_json += "]";
    }

    // Duplicate to a C-allocated string so caller can free with acestep_string_free
    char * result = (char *) malloc(result_json.size() + 1);
    if (!result) {
        set_error("Failed to allocate result string");
        return NULL;
    }
    memcpy(result, result_json.c_str(), result_json.size() + 1);
    return result;
}

// =====================================================================
// Audio file I/O
// =====================================================================

extern "C" float * acestep_audio_read_file(const char * path, int32_t * out_len) {
    if (!path || !out_len) {
        set_error("path and out_len are required");
        return NULL;
    }
    *out_len = 0;

    int T_audio = 0;
    float * planar = audio_read_48k(path, &T_audio);
    if (!planar) {
        set_error("Failed to read audio file: %s", path);
        return NULL;
    }

    // Convert planar [L..,R..] to interleaved [L,R,L,R,...]
    float * interleaved = audio_planar_to_interleaved(planar, T_audio);
    free(planar);

    if (!interleaved) {
        set_error("Failed to convert audio to interleaved format");
        return NULL;
    }

    *out_len = T_audio;
    return interleaved;
}

extern "C" void acestep_interleaved_free(float * buf) {
    free(buf);
}

extern "C" bool acestep_audio_write_file(
    const char *    path,
    const float *   planar_samples,
    int32_t         n_samples,
    const char *    format,
    int32_t         mp3_bitrate
) {
    if (!path || !planar_samples || !format) {
        set_error("path, planar_samples and format are required");
        return false;
    }

    bool      is_mp3  = true;
    WavFormat wav_fmt = WAV_S16;
    if (!audio_parse_format(format, is_mp3, wav_fmt)) {
        set_error("Invalid output_format '%s' (use: mp3, wav16, wav24, wav32)", format);
        return false;
    }

    int kbps = (mp3_bitrate > 0) ? mp3_bitrate : 128;

    // audio_write modifies the buffer in-place (peak normalization), so make a copy
    size_t total = (size_t) n_samples * 2;  // planar stereo: 2 * n_samples
    float * buf_copy = (float *) malloc(total * sizeof(float));
    if (!buf_copy) {
        set_error("Failed to allocate audio buffer copy");
        return false;
    }
    memcpy(buf_copy, planar_samples, total * sizeof(float));

    bool ok = audio_write(path, buf_copy, n_samples, 48000, kbps, wav_fmt);
    free(buf_copy);

    if (!ok) {
        set_error("Failed to write audio file: %s", path);
        return false;
    }

    return true;
}

extern "C" float * acestep_planar_to_interleaved(const float * planar, int32_t n_samples) {
    if (!planar || n_samples <= 0) {
        set_error("Invalid planar buffer");
        return NULL;
    }
    // planar: [L0..LN, R0..RN] (2 * n_samples floats)
    // interleaved: [L0,R0,L1,R1,...] (2 * n_samples floats)
    float * interleaved = (float *) malloc(sizeof(float) * 2 * n_samples);
    if (!interleaved) {
        set_error("Failed to allocate interleaved buffer");
        return NULL;
    }
    const float * L = planar;
    const float * R = planar + n_samples;
    for (int32_t i = 0; i < n_samples; i++) {
        interleaved[2 * i]     = L[i];
        interleaved[2 * i + 1] = R[i];
    }
    return interleaved;
}

extern "C" float * acestep_interleaved_to_planar(const float * interleaved, int32_t n_samples) {
    if (!interleaved || n_samples <= 0) {
        set_error("Invalid interleaved buffer");
        return NULL;
    }
    // interleaved: [L0,R0,L1,R1,...] (2 * n_samples floats)
    // planar: [L0..LN, R0..RN] (2 * n_samples floats)
    float * planar = (float *) malloc(sizeof(float) * 2 * n_samples);
    if (!planar) {
        set_error("Failed to allocate planar buffer");
        return NULL;
    }
    float * L = planar;
    float * R = planar + n_samples;
    for (int32_t i = 0; i < n_samples; i++) {
        L[i] = interleaved[2 * i];
        R[i] = interleaved[2 * i + 1];
    }
    return planar;
}

// =====================================================================
// Utilities
// =====================================================================

extern "C" void acestep_audio_free(AceStepAudio * audio) {
    if (!audio) return;
    if (audio->samples) {
        free(audio->samples);
        audio->samples = NULL;
    }
    audio->n_samples   = 0;
    audio->sample_rate = 0;
}

extern "C" void acestep_string_free(char * str) {
    free(str);
}
