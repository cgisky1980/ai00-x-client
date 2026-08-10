#include "forced_aligner.h"
#include "mel_spectrogram.h"

#include <cctype>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <climits>
#include <chrono>
#include <algorithm>
#include <fstream>
#include <sstream>

#ifdef _WIN32
#include <windows.h>
#include <io.h>
#define FA_LOG(msg) do { fprintf(stderr, "[FA-CPP] %s\n", msg); fflush(stderr); OutputDebugStringA("[FA-CPP] " msg "\n"); } while (0)
#define FA_LOGF(fmt, ...) do { fprintf(stderr, "[FA-CPP] " fmt "\n", __VA_ARGS__); fflush(stderr); char _b[512]; snprintf(_b, sizeof(_b), "[FA-CPP] " fmt "\n", __VA_ARGS__); OutputDebugStringA(_b); } while (0)
#else
#define FA_LOG(msg) do { fprintf(stderr, "[FA-CPP] %s\n", msg); fflush(stderr); } while (0)
#define FA_LOGF(fmt, ...) do { fprintf(stderr, "[FA-CPP] " fmt "\n", __VA_ARGS__); fflush(stderr); } while (0)
#endif

#define QWEN3_FA_MAX_NODES 16384

namespace qwen3_asr {

static int64_t get_time_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

static void compute_sinusoidal_pe(float * pe, int n_ctx, int d_model) {
    const int half_dim = d_model / 2;
    for (int pos = 0; pos < n_ctx; ++pos) {
        for (int i = 0; i < half_dim; ++i) {
            float div_term = expf(-logf(10000.0f) * i / (half_dim - 1));
            float angle = pos * div_term;
            pe[pos * d_model + i] = sinf(angle);
            pe[pos * d_model + half_dim + i] = cosf(angle);
        }
    }
}

ForcedAligner::ForcedAligner() = default;

ForcedAligner::~ForcedAligner() {
    free_kv_cache();
    if (state_.sched) {
        ggml_backend_sched_free(state_.sched);
        state_.sched = nullptr;
    }
    if (state_.backend_gpu) {
        ggml_backend_free(state_.backend_gpu);
        state_.backend_gpu = nullptr;
    }
    if (state_.backend_cpu) {
        ggml_backend_free(state_.backend_cpu);
        state_.backend_cpu = nullptr;
    }
    free_forced_aligner_model(model_);
}

bool ForcedAligner::load_model(const std::string & model_path) {
    FA_LOGF("load_model: path=%s", model_path.c_str());

    struct ggml_context * meta_ctx = nullptr;
    struct gguf_init_params params = {
        /*.no_alloc =*/ true,
        /*.ctx      =*/ &meta_ctx,
    };

    FA_LOG("load_model: calling gguf_init_from_file...");
    struct gguf_context * ctx = gguf_init_from_file(model_path.c_str(), params);
    if (!ctx) {
        error_msg_ = "Failed to open GGUF file: " + model_path;
        FA_LOG("load_model: gguf_init_from_file FAILED");
        return false;
    }
    FA_LOG("load_model: gguf_init_from_file OK");

    FA_LOG("load_model: parse_hparams...");
    if (!parse_hparams(ctx)) {
        gguf_free(ctx);
        if (meta_ctx) ggml_free(meta_ctx);
        return false;
    }
    FA_LOGF("load_model: hparams OK: encoder_layers=%d, d_model=%d, decoder_layers=%d",
            model_.hparams.audio_encoder_layers, model_.hparams.audio_d_model,
            model_.hparams.text_decoder_layers);

    FA_LOG("load_model: create_tensors...");
    if (!create_tensors(ctx)) {
        FA_LOGF("load_model: create_tensors FAILED: %s", error_msg_.c_str());
        gguf_free(ctx);
        if (meta_ctx) ggml_free(meta_ctx);
        return false;
    }
    FA_LOG("load_model: create_tensors OK");

    FA_LOG("load_model: load_tensor_data...");
    if (!load_tensor_data(model_path, ctx)) {
        FA_LOGF("load_model: load_tensor_data FAILED: %s", error_msg_.c_str());
        free_forced_aligner_model(model_);
        gguf_free(ctx);
        if (meta_ctx) ggml_free(meta_ctx);
        return false;
    }
    FA_LOG("load_model: load_tensor_data OK");

    FA_LOG("load_model: load_vocab...");
    if (!load_vocab(ctx)) {
        FA_LOGF("load_model: load_vocab FAILED: %s", error_msg_.c_str());
        free_forced_aligner_model(model_);
        gguf_free(ctx);
        if (meta_ctx) ggml_free(meta_ctx);
        return false;
    }
    FA_LOG("load_model: load_vocab OK");

    gguf_free(ctx);
    if (meta_ctx) ggml_free(meta_ctx);

    FA_LOG("load_model: init CPU backend...");
    state_.backend_cpu = ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
    if (!state_.backend_cpu) {
        error_msg_ = "Failed to initialize CPU backend";
        FA_LOG("load_model: CPU backend FAILED");
        return false;
    }
    FA_LOG("load_model: CPU backend OK");

    FA_LOG("load_model: init GPU backend...");
    state_.backend_gpu = ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_GPU, nullptr);
    FA_LOGF("load_model: GPU backend = %p", (void*)state_.backend_gpu);

    std::vector<ggml_backend_t> backends;
    std::vector<ggml_backend_buffer_type_t> backend_bufts;

    if (state_.backend_gpu) {
        backends.push_back(state_.backend_gpu);
        backend_bufts.push_back(ggml_backend_get_default_buffer_type(state_.backend_gpu));
        FA_LOG("load_model: GPU backend added to scheduler");
    } else {
        FA_LOG("load_model: GPU backend NULL, CPU-only mode");
    }

    backends.push_back(state_.backend_cpu);
    // Use plain CPU buffer type (NOT the GPU host/pinned buffer type).
    // The CUDA host buffer type (cudaHostRegister) fails for large audio:
    // 180s audio → 3.47 GB intermediate buffer → "resource already mapped"
    // error. Plain CPU buffers have no such limit; H2D transfers are slightly
    // slower (non-pinned) but the scheduler still offloads matmuls to GPU.
    ggml_backend_buffer_type_t cpu_buft = ggml_backend_get_default_buffer_type(state_.backend_cpu);
    backend_bufts.push_back(cpu_buft);

    FA_LOG("load_model: creating backend scheduler...");
    state_.sched = ggml_backend_sched_new(backends.data(), backend_bufts.data(), backends.size(), QWEN3_FA_MAX_NODES, false, true);
    if (!state_.sched) {
        error_msg_ = "Failed to create backend scheduler";
        FA_LOG("load_model: backend scheduler FAILED");
        return false;
    }
    FA_LOG("load_model: backend scheduler OK");

    state_.compute_meta.resize(ggml_tensor_overhead() * QWEN3_FA_MAX_NODES + ggml_graph_overhead());

    model_loaded_ = true;
    FA_LOG("load_model: ALL OK");
    return true;
}

bool ForcedAligner::parse_hparams(struct gguf_context * ctx) {
    auto get_u32 = [&](const char * key, int32_t default_val) -> int32_t {
        int64_t idx = gguf_find_key(ctx, key);
        if (idx < 0) return default_val;
        return (int32_t)gguf_get_val_u32(ctx, idx);
    };
    
    auto get_f32 = [&](const char * key, float default_val) -> float {
        int64_t idx = gguf_find_key(ctx, key);
        if (idx < 0) return default_val;
        return gguf_get_val_f32(ctx, idx);
    };
    
    auto & hp = model_.hparams;
    
    hp.audio_encoder_layers = get_u32("qwen3-asr.audio.encoder.layer_count", 24);
    hp.audio_d_model = get_u32("qwen3-asr.audio.encoder.embedding_length", 1024);
    hp.audio_attention_heads = get_u32("qwen3-asr.audio.encoder.attention.head_count", 16);
    hp.audio_ffn_dim = get_u32("qwen3-asr.audio.encoder.feed_forward_length", 4096);
    hp.audio_num_mel_bins = get_u32("qwen3-asr.audio.num_mel_bins", 128);
    hp.audio_conv_channels = get_u32("qwen3-asr.audio.conv_channels", 480);
    
    hp.text_decoder_layers = get_u32("qwen3-asr.block_count", 28);
    hp.text_hidden_size = get_u32("qwen3-asr.embedding_length", 1024);
    hp.text_attention_heads = get_u32("qwen3-asr.attention.head_count", 16);
    hp.text_kv_heads = get_u32("qwen3-asr.attention.head_count_kv", 8);
    hp.text_intermediate_size = get_u32("qwen3-asr.feed_forward_length", 3072);
    hp.text_head_dim = get_u32("qwen3-asr.attention.key_length", 128);
    hp.text_rms_norm_eps = get_f32("qwen3-asr.attention.layer_norm_rms_epsilon", 1e-6f);
    hp.text_rope_theta = get_f32("qwen3-asr.rope.freq_base", 1000000.0f);
    hp.vocab_size = get_u32("qwen3-asr.vocab_size", 152064);
    
    hp.classify_num = get_u32("qwen3-asr.classify_num", 5000);
    hp.timestamp_token_id = get_u32("qwen3-asr.timestamp_token_id", 151705);
    hp.audio_start_token_id = get_u32("qwen3-asr.audio.start_token_id", 151669);
    hp.audio_end_token_id = get_u32("qwen3-asr.audio.end_token_id", 151670);
    hp.audio_pad_token_id = get_u32("qwen3-asr.audio.pad_token_id", 151676);
    
    return true;
}

bool ForcedAligner::create_tensors(struct gguf_context * ctx) {
    const int64_t n_tensors = gguf_get_n_tensors(ctx);
    const auto & hp = model_.hparams;
    
    const size_t ctx_size = n_tensors * ggml_tensor_overhead();
    struct ggml_init_params params = {
        /*.mem_size   =*/ ctx_size,
        /*.mem_buffer =*/ nullptr,
        /*.no_alloc   =*/ true,
    };
    
    model_.ctx = ggml_init(params);
    if (!model_.ctx) {
        error_msg_ = "Failed to create GGML context";
        return false;
    }
    
    model_.encoder_layers.resize(hp.audio_encoder_layers);
    model_.decoder_layers.resize(hp.text_decoder_layers);
    
    for (int64_t i = 0; i < n_tensors; ++i) {
        const char * name = gguf_get_tensor_name(ctx, i);
        enum ggml_type type = gguf_get_tensor_type(ctx, i);
        
        int64_t ne[GGML_MAX_DIMS] = {1, 1, 1, 1};
        int n_dims = 0;
        
        if (strstr(name, "encoder.conv1.weight")) {
            ne[0] = 3; ne[1] = 3; ne[2] = 1; ne[3] = hp.audio_conv_channels;
            n_dims = 4;
        } else if (strstr(name, "encoder.conv2.weight") || strstr(name, "encoder.conv3.weight")) {
            ne[0] = 3; ne[1] = 3; ne[2] = hp.audio_conv_channels; ne[3] = hp.audio_conv_channels;
            n_dims = 4;
        } else if (strstr(name, "encoder.conv1.bias") || strstr(name, "encoder.conv2.bias") || 
                   strstr(name, "encoder.conv3.bias")) {
            ne[0] = hp.audio_conv_channels;
            n_dims = 1;
        } else if (strstr(name, "encoder.conv_out.weight")) {
            ne[0] = hp.audio_conv_channels * 16;
            ne[1] = hp.audio_d_model;
            n_dims = 2;
        } else if (strstr(name, "audio.encoder.blk.")) {
            int layer_idx = -1;
            if (sscanf(name, "audio.encoder.blk.%d.", &layer_idx) == 1 && 
                layer_idx >= 0 && layer_idx < hp.audio_encoder_layers) {
                
                if (strstr(name, "attn_q.weight") || strstr(name, "attn_k.weight") || 
                    strstr(name, "attn_v.weight") || strstr(name, "attn_out.weight")) {
                    ne[0] = hp.audio_d_model;
                    ne[1] = hp.audio_d_model;
                    n_dims = 2;
                } else if (strstr(name, "attn_q.bias") || strstr(name, "attn_k.bias") || 
                           strstr(name, "attn_v.bias") || strstr(name, "attn_out.bias") ||
                           strstr(name, "attn_norm.weight") || strstr(name, "attn_norm.bias")) {
                    ne[0] = hp.audio_d_model;
                    n_dims = 1;
                } else if (strstr(name, "ffn_up.weight")) {
                    ne[0] = hp.audio_d_model;
                    ne[1] = hp.audio_ffn_dim;
                    n_dims = 2;
                } else if (strstr(name, "ffn_down.weight")) {
                    ne[0] = hp.audio_ffn_dim;
                    ne[1] = hp.audio_d_model;
                    n_dims = 2;
                } else if (strstr(name, "ffn_up.bias")) {
                    ne[0] = hp.audio_ffn_dim;
                    n_dims = 1;
                } else if (strstr(name, "ffn_down.bias") || strstr(name, "ffn_norm.weight") || 
                           strstr(name, "ffn_norm.bias")) {
                    ne[0] = hp.audio_d_model;
                    n_dims = 1;
                }
            }
        } else if (strstr(name, "encoder.ln_post.weight") || strstr(name, "encoder.ln_post.bias")) {
            ne[0] = hp.audio_d_model;
            n_dims = 1;
        } else if (strstr(name, "encoder.proj1.weight")) {
            ne[0] = hp.audio_d_model;
            ne[1] = hp.audio_d_model;
            n_dims = 2;
        } else if (strstr(name, "encoder.proj1.bias")) {
            ne[0] = hp.audio_d_model;
            n_dims = 1;
        } else if (strstr(name, "encoder.proj2.weight")) {
            ne[0] = hp.audio_d_model;
            ne[1] = hp.text_hidden_size;
            n_dims = 2;
        } else if (strstr(name, "encoder.proj2.bias")) {
            ne[0] = hp.text_hidden_size;
            n_dims = 1;
        } else if (strstr(name, "token_embd.weight")) {
            ne[0] = hp.text_hidden_size;
            ne[1] = hp.vocab_size;
            n_dims = 2;
        } else if (strstr(name, "output_norm.weight")) {
            ne[0] = hp.text_hidden_size;
            n_dims = 1;
        } else if (strstr(name, "output.weight") && !strstr(name, "attn_output.weight")) {
            ne[0] = hp.text_hidden_size;
            ne[1] = hp.classify_num;
            n_dims = 2;
        } else if (strstr(name, "blk.") && !strstr(name, "audio.encoder.blk.")) {
            int layer_idx = -1;
            if (sscanf(name, "blk.%d.", &layer_idx) == 1 && 
                layer_idx >= 0 && layer_idx < hp.text_decoder_layers) {
                
                if (strstr(name, "attn_norm.weight")) {
                    ne[0] = hp.text_hidden_size;
                    n_dims = 1;
                } else if (strstr(name, "attn_q_norm.weight") || strstr(name, "attn_k_norm.weight")) {
                    ne[0] = hp.text_head_dim;
                    n_dims = 1;
                } else if (strstr(name, "attn_q.weight")) {
                    ne[0] = hp.text_hidden_size;
                    ne[1] = hp.text_attention_heads * hp.text_head_dim;
                    n_dims = 2;
                } else if (strstr(name, "attn_k.weight")) {
                    ne[0] = hp.text_hidden_size;
                    ne[1] = hp.text_kv_heads * hp.text_head_dim;
                    n_dims = 2;
                } else if (strstr(name, "attn_v.weight")) {
                    ne[0] = hp.text_hidden_size;
                    ne[1] = hp.text_kv_heads * hp.text_head_dim;
                    n_dims = 2;
                } else if (strstr(name, "attn_output.weight")) {
                    ne[0] = hp.text_attention_heads * hp.text_head_dim;
                    ne[1] = hp.text_hidden_size;
                    n_dims = 2;
                } else if (strstr(name, "ffn_norm.weight")) {
                    ne[0] = hp.text_hidden_size;
                    n_dims = 1;
                } else if (strstr(name, "ffn_gate.weight") || strstr(name, "ffn_up.weight")) {
                    ne[0] = hp.text_hidden_size;
                    ne[1] = hp.text_intermediate_size;
                    n_dims = 2;
                } else if (strstr(name, "ffn_down.weight")) {
                    ne[0] = hp.text_intermediate_size;
                    ne[1] = hp.text_hidden_size;
                    n_dims = 2;
                }
            }
        } else {
            continue;
        }
        
        if (n_dims == 0) continue;
        
        struct ggml_tensor * tensor = ggml_new_tensor(model_.ctx, type, n_dims, ne);
        if (!tensor) {
            error_msg_ = "Failed to create tensor: " + std::string(name);
            return false;
        }
        ggml_set_name(tensor, name);
        model_.tensors[name] = tensor;
        
        if (strstr(name, "encoder.conv1.weight")) {
            model_.conv2d1_w = tensor;
        } else if (strstr(name, "encoder.conv1.bias")) {
            model_.conv2d1_b = tensor;
        } else if (strstr(name, "encoder.conv2.weight")) {
            model_.conv2d2_w = tensor;
        } else if (strstr(name, "encoder.conv2.bias")) {
            model_.conv2d2_b = tensor;
        } else if (strstr(name, "encoder.conv3.weight")) {
            model_.conv2d3_w = tensor;
        } else if (strstr(name, "encoder.conv3.bias")) {
            model_.conv2d3_b = tensor;
        } else if (strstr(name, "encoder.conv_out.weight")) {
            model_.conv_out_w = tensor;
        } else if (strstr(name, "encoder.ln_post.weight")) {
            model_.ln_post_w = tensor;
        } else if (strstr(name, "encoder.ln_post.bias")) {
            model_.ln_post_b = tensor;
        } else if (strstr(name, "encoder.proj1.weight")) {
            model_.proj1_w = tensor;
        } else if (strstr(name, "encoder.proj1.bias")) {
            model_.proj1_b = tensor;
        } else if (strstr(name, "encoder.proj2.weight")) {
            model_.proj2_w = tensor;
        } else if (strstr(name, "encoder.proj2.bias")) {
            model_.proj2_b = tensor;
        } else if (strstr(name, "audio.encoder.blk.")) {
            int layer_idx = -1;
            if (sscanf(name, "audio.encoder.blk.%d.", &layer_idx) == 1 && 
                layer_idx >= 0 && layer_idx < hp.audio_encoder_layers) {
                auto & layer = model_.encoder_layers[layer_idx];
                
                if (strstr(name, "attn_q.weight")) layer.attn_q_w = tensor;
                else if (strstr(name, "attn_q.bias")) layer.attn_q_b = tensor;
                else if (strstr(name, "attn_k.weight")) layer.attn_k_w = tensor;
                else if (strstr(name, "attn_k.bias")) layer.attn_k_b = tensor;
                else if (strstr(name, "attn_v.weight")) layer.attn_v_w = tensor;
                else if (strstr(name, "attn_v.bias")) layer.attn_v_b = tensor;
                else if (strstr(name, "attn_out.weight")) layer.attn_out_w = tensor;
                else if (strstr(name, "attn_out.bias")) layer.attn_out_b = tensor;
                else if (strstr(name, "attn_norm.weight")) layer.attn_norm_w = tensor;
                else if (strstr(name, "attn_norm.bias")) layer.attn_norm_b = tensor;
                else if (strstr(name, "ffn_up.weight")) layer.ffn_up_w = tensor;
                else if (strstr(name, "ffn_up.bias")) layer.ffn_up_b = tensor;
                else if (strstr(name, "ffn_down.weight")) layer.ffn_down_w = tensor;
                else if (strstr(name, "ffn_down.bias")) layer.ffn_down_b = tensor;
                else if (strstr(name, "ffn_norm.weight")) layer.ffn_norm_w = tensor;
                else if (strstr(name, "ffn_norm.bias")) layer.ffn_norm_b = tensor;
            }
        } else if (strstr(name, "token_embd.weight")) {
            model_.token_embd = tensor;
        } else if (strstr(name, "output_norm.weight")) {
            model_.output_norm = tensor;
        } else if (strstr(name, "output.weight") && !strstr(name, "attn_output.weight")) {
            model_.classify_head_w = tensor;
        } else if (strstr(name, "blk.") && !strstr(name, "audio.encoder.blk.")) {
            int layer_idx = -1;
            if (sscanf(name, "blk.%d.", &layer_idx) == 1 && 
                layer_idx >= 0 && layer_idx < hp.text_decoder_layers) {
                auto & layer = model_.decoder_layers[layer_idx];
                
                if (strstr(name, "attn_norm.weight")) layer.attn_norm = tensor;
                else if (strstr(name, "attn_q_norm.weight")) layer.attn_q_norm = tensor;
                else if (strstr(name, "attn_k_norm.weight")) layer.attn_k_norm = tensor;
                else if (strstr(name, "attn_q.weight")) layer.attn_q = tensor;
                else if (strstr(name, "attn_k.weight")) layer.attn_k = tensor;
                else if (strstr(name, "attn_v.weight")) layer.attn_v = tensor;
                else if (strstr(name, "attn_output.weight")) layer.attn_output = tensor;
                else if (strstr(name, "ffn_norm.weight")) layer.ffn_norm = tensor;
                else if (strstr(name, "ffn_gate.weight")) layer.ffn_gate = tensor;
                else if (strstr(name, "ffn_up.weight")) layer.ffn_up = tensor;
                else if (strstr(name, "ffn_down.weight")) layer.ffn_down = tensor;
            }
        }
    }
    
    return true;
}

bool ForcedAligner::load_tensor_data(const std::string & path, struct gguf_context * ctx) {
    void * mmap_addr = nullptr;
    size_t file_size = 0;

#ifdef _WIN32
    // Use PAGE_WRITECOPY + FILE_MAP_COPY to get copy-on-write semantics
    // matching Linux's MAP_PRIVATE. This avoids STATUS_ACCESS_VIOLATION if
    // ggml or CUDA internally writes to the mapped region (e.g. buffer
    // metadata, cudaHostRegister bookkeeping).
    HANDLE hFile = CreateFileA(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                               OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hFile == INVALID_HANDLE_VALUE) {
        error_msg_ = "Failed to open file for mmap: " + path;
        return false;
    }
    LARGE_INTEGER li;
    if (!GetFileSizeEx(hFile, &li)) {
        error_msg_ = "Failed to stat file: " + path;
        CloseHandle(hFile);
        return false;
    }
    file_size = (size_t)li.QuadPart;
    HANDLE hMap = CreateFileMappingA(hFile, nullptr, PAGE_WRITECOPY, 0, 0, nullptr);
    CloseHandle(hFile);
    if (!hMap) {
        error_msg_ = "Failed to create file mapping: " + path;
        return false;
    }
    mmap_addr = MapViewOfFile(hMap, FILE_MAP_COPY, 0, 0, 0);
    CloseHandle(hMap);
    if (!mmap_addr) {
        error_msg_ = "Failed to mmap file: " + path;
        return false;
    }
#else
    int fd = open(path.c_str(), O_RDONLY);
    if (fd < 0) {
        error_msg_ = "Failed to open file for mmap: " + path;
        return false;
    }
    struct stat st;
    if (fstat(fd, &st) != 0) {
        error_msg_ = "Failed to stat file: " + path;
        close(fd);
        return false;
    }
    file_size = st.st_size;
    mmap_addr = mmap(nullptr, file_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (mmap_addr == MAP_FAILED) {
        error_msg_ = "Failed to mmap file: " + path;
        return false;
    }
#endif

    model_.mmap_addr = mmap_addr;
    model_.mmap_size = file_size;

    const size_t data_offset = gguf_get_data_offset(ctx);
    const size_t total_size = file_size - data_offset;
    uint8_t * data_base = (uint8_t *)mmap_addr + data_offset;

    const int64_t n_tensors = gguf_get_n_tensors(ctx);
    size_t max_tensor_size = 0;
    for (int64_t i = 0; i < n_tensors; ++i) {
        size_t sz = gguf_get_tensor_size(ctx, i);
        if (sz > max_tensor_size) max_tensor_size = sz;
    }

    // Create a CPU buffer wrapping the mmap region. The ggml backend scheduler
    // will automatically offload compute to GPU when beneficial — model
    // weights in CPU memory are transparently transferred on first access.
    //
    // We deliberately skip ggml_backend_dev_buffer_from_host_ptr() for the GPU
    // device because on Windows it crashes (STATUS_ACCESS_VIOLATION) when
    // called with MapViewOfFile memory — the CUDA backend's cudaHostRegister
    // path is incompatible with Windows file-mapping pages. The scheduler
    // still uses GPU for all matmul/attention ops; only weight storage stays
    // on CPU, with automatic H2D copies as needed.
    model_.buffer = ggml_backend_cpu_buffer_from_ptr(data_base, total_size);
    if (!model_.buffer) {
        error_msg_ = "Failed to create buffer from mmap";
#ifdef _WIN32
        UnmapViewOfFile(mmap_addr);
#else
        munmap(mmap_addr, file_size);
#endif
        model_.mmap_addr = nullptr;
        model_.mmap_size = 0;
        return false;
    }

    for (int64_t i = 0; i < n_tensors; ++i) {
        const char * name = gguf_get_tensor_name(ctx, i);
        size_t offset = gguf_get_tensor_offset(ctx, i);

        auto it = model_.tensors.find(name);
        if (it == model_.tensors.end()) continue;

        struct ggml_tensor * tensor = it->second;
        tensor->buffer = model_.buffer;
        tensor->data = data_base + offset;
    }

    return true;
}

bool ForcedAligner::load_vocab(struct gguf_context * ctx) {
    int64_t tokens_idx = gguf_find_key(ctx, "tokenizer.ggml.tokens");
    if (tokens_idx < 0) {
        error_msg_ = "Vocabulary not found in GGUF file";
        return false;
    }
    
    int64_t n_vocab = gguf_get_arr_n(ctx, tokens_idx);
    if (n_vocab <= 0) {
        error_msg_ = "Empty vocabulary in GGUF file";
        return false;
    }
    
    model_.vocab.resize(n_vocab);
    for (int64_t i = 0; i < n_vocab; ++i) {
        model_.vocab[i] = gguf_get_arr_str(ctx, tokens_idx, i);
    }
    
    for (int64_t i = 0; i < n_vocab; ++i) {
        model_.token_to_id[model_.vocab[i]] = static_cast<int32_t>(i);
    }
    
    int64_t merges_idx = gguf_find_key(ctx, "tokenizer.ggml.merges");
    if (merges_idx >= 0) {
        int64_t n_merges = gguf_get_arr_n(ctx, merges_idx);
        for (int64_t i = 0; i < n_merges; ++i) {
            std::string merge = gguf_get_arr_str(ctx, merges_idx, i);
            model_.bpe_ranks[merge] = static_cast<int>(i);
        }
    }
    
    return true;
}

bool ForcedAligner::init_kv_cache(int32_t n_ctx) {
    const auto & hp = model_.hparams;
    
    free_kv_cache();
    
    state_.cache.n_ctx = n_ctx;
    state_.cache.n_used = 0;
    state_.cache.head_dim = hp.text_head_dim;
    state_.cache.n_kv_heads = hp.text_kv_heads;
    state_.cache.n_layers = hp.text_decoder_layers;
    
    const size_t n_tensors = hp.text_decoder_layers * 2;
    const size_t ctx_size = n_tensors * ggml_tensor_overhead();
    
    struct ggml_init_params params = {
        /*.mem_size   =*/ ctx_size,
        /*.mem_buffer =*/ nullptr,
        /*.no_alloc   =*/ true,
    };
    
    state_.cache.ctx = ggml_init(params);
    if (!state_.cache.ctx) {
        error_msg_ = "Failed to create KV cache context";
        return false;
    }
    
    state_.cache.k_cache.resize(hp.text_decoder_layers);
    state_.cache.v_cache.resize(hp.text_decoder_layers);
    
    for (int il = 0; il < hp.text_decoder_layers; ++il) {
        state_.cache.k_cache[il] = ggml_new_tensor_3d(
            state_.cache.ctx, GGML_TYPE_F16,
            hp.text_head_dim, hp.text_kv_heads, n_ctx);
        ggml_format_name(state_.cache.k_cache[il], "k_cache_%d", il);
        
        state_.cache.v_cache[il] = ggml_new_tensor_3d(
            state_.cache.ctx, GGML_TYPE_F16,
            hp.text_head_dim, hp.text_kv_heads, n_ctx);
        ggml_format_name(state_.cache.v_cache[il], "v_cache_%d", il);
    }
    
    ggml_backend_t kv_backend = state_.backend_gpu ? state_.backend_gpu : state_.backend_cpu;
    state_.cache.buffer = ggml_backend_alloc_ctx_tensors(state_.cache.ctx, kv_backend);
    if (!state_.cache.buffer) {
        error_msg_ = "Failed to allocate KV cache buffer";
        return false;
    }
    
    return true;
}

void ForcedAligner::clear_kv_cache() {
    state_.cache.n_used = 0;
}

void ForcedAligner::free_kv_cache() {
    if (state_.cache.buffer) {
        ggml_backend_buffer_free(state_.cache.buffer);
        state_.cache.buffer = nullptr;
    }
    if (state_.cache.ctx) {
        ggml_free(state_.cache.ctx);
        state_.cache.ctx = nullptr;
    }
    state_.cache.k_cache.clear();
    state_.cache.v_cache.clear();
    state_.cache.n_ctx = 0;
    state_.cache.n_used = 0;
}

// Conv2d output size: floor((input + 2*pad - kernel) / stride) + 1
// With pad=1, kernel=3, stride=2: (input - 1) / 2 + 1
static int32_t chunk_output_len(int32_t chunk_frames) {
    int32_t len = chunk_frames;
    for (int i = 0; i < 3; ++i) {
        len = (len - 1) / 2 + 1;
    }
    return len;
}

bool ForcedAligner::encode_audio(const float * mel_data, int n_mel, int n_frames,
                                  std::vector<float> & output) {
    const auto & hp = model_.hparams;
    const int n_state = hp.audio_d_model;
    const int n_head = hp.audio_attention_heads;
    const int n_layer = hp.audio_encoder_layers;
    const int n_state_head = n_state / n_head;
    const float eps = hp.audio_layer_norm_eps;
    const float KQscale = 1.0f / sqrtf(float(n_state_head));

    const int32_t n_window = 50;
    const int32_t chunk_mel_size = n_window * 2;
    const int32_t n_window_infer = 800;
    const int32_t n_chunks = (n_frames + chunk_mel_size - 1) / chunk_mel_size;

    std::vector<int32_t> chunk_lengths(n_chunks);
    std::vector<int32_t> chunk_out_lens(n_chunks);
    int32_t max_chunk_len = chunk_mel_size;
    int32_t total_out_frames = 0;

    for (int32_t c = 0; c < n_chunks; ++c) {
        if (c < n_chunks - 1) {
            chunk_lengths[c] = chunk_mel_size;
        } else {
            chunk_lengths[c] = n_frames - c * chunk_mel_size;
            if (chunk_lengths[c] == 0) chunk_lengths[c] = chunk_mel_size;
        }
        chunk_out_lens[c] = chunk_output_len(chunk_lengths[c]);
        total_out_frames += chunk_out_lens[c];
    }

    const int32_t max_out_w = chunk_output_len(max_chunk_len);

    struct ggml_init_params params = {
        /*.mem_size   =*/ state_.compute_meta.size(),
        /*.mem_buffer =*/ state_.compute_meta.data(),
        /*.no_alloc   =*/ true,
    };

    struct ggml_context * ctx0 = ggml_init(params);
    struct ggml_cgraph * gf = ggml_new_graph_custom(ctx0, QWEN3_FA_MAX_NODES, false);

    struct ggml_tensor * mel_batch = ggml_new_tensor_4d(ctx0, GGML_TYPE_F32,
        max_chunk_len, n_mel, 1, n_chunks);
    ggml_set_name(mel_batch, "mel_batch");
    ggml_set_input(mel_batch);

    struct ggml_tensor * cur = ggml_conv_2d(ctx0, model_.conv2d1_w, mel_batch, 2, 2, 1, 1, 1, 1);
    if (model_.conv2d1_b) {
        struct ggml_tensor * bias = ggml_reshape_4d(ctx0, model_.conv2d1_b, 1, 1, hp.audio_conv_channels, 1);
        cur = ggml_add(ctx0, cur, bias);
    }
    cur = ggml_gelu(ctx0, cur);

    cur = ggml_conv_2d(ctx0, model_.conv2d2_w, cur, 2, 2, 1, 1, 1, 1);
    if (model_.conv2d2_b) {
        struct ggml_tensor * bias = ggml_reshape_4d(ctx0, model_.conv2d2_b, 1, 1, hp.audio_conv_channels, 1);
        cur = ggml_add(ctx0, cur, bias);
    }
    cur = ggml_gelu(ctx0, cur);

    cur = ggml_conv_2d(ctx0, model_.conv2d3_w, cur, 2, 2, 1, 1, 1, 1);
    if (model_.conv2d3_b) {
        struct ggml_tensor * bias = ggml_reshape_4d(ctx0, model_.conv2d3_b, 1, 1, hp.audio_conv_channels, 1);
        cur = ggml_add(ctx0, cur, bias);
    }
    cur = ggml_gelu(ctx0, cur);

    // [out_w, out_h, out_c, n_chunks] -> permute -> conv_out -> [n_state, out_w, n_chunks]
    int64_t conv_out_w = cur->ne[0];
    int64_t conv_out_h = cur->ne[1];
    int64_t conv_out_c = cur->ne[2];
    int64_t feat_dim = conv_out_c * conv_out_h;

    cur = ggml_reshape_3d(ctx0, cur, conv_out_w, feat_dim, n_chunks);
    cur = ggml_cont(ctx0, ggml_permute(ctx0, cur, 1, 0, 2, 3));
    cur = ggml_reshape_2d(ctx0, cur, feat_dim, conv_out_w * n_chunks);
    if (model_.conv_out_w) {
        cur = ggml_mul_mat(ctx0, model_.conv_out_w, cur);
    }
    cur = ggml_reshape_3d(ctx0, cur, n_state, conv_out_w, n_chunks);

    ggml_set_name(cur, "conv_out");
    ggml_set_output(cur);

    ggml_build_forward_expand(gf, cur);

    if (!ggml_backend_sched_alloc_graph(state_.sched, gf)) {
        error_msg_ = "Failed to allocate conv graph";
        ggml_free(ctx0);
        return false;
    }

    {
        size_t batch_size = (size_t)max_chunk_len * n_mel * 1 * n_chunks;
        std::vector<float> mel_batch_data(batch_size, 0.0f);

        for (int32_t c = 0; c < n_chunks; ++c) {
            int32_t clen = chunk_lengths[c];
            int32_t start_frame = c * chunk_mel_size;
            for (int m = 0; m < n_mel; ++m) {
                for (int f = 0; f < clen; ++f) {
                    size_t idx = (size_t)f + (size_t)m * max_chunk_len
                                 + (size_t)c * max_chunk_len * n_mel;
                    mel_batch_data[idx] = mel_data[m * n_frames + start_frame + f];
                }
            }
        }

        struct ggml_tensor * mel_t = ggml_graph_get_tensor(gf, "mel_batch");
        ggml_backend_tensor_set(mel_t, mel_batch_data.data(), 0, batch_size * sizeof(float));
    }

    if (ggml_backend_sched_graph_compute(state_.sched, gf) != GGML_STATUS_SUCCESS) {
        error_msg_ = "Failed to compute conv graph";
        ggml_backend_sched_reset(state_.sched);
        ggml_free(ctx0);
        return false;
    }

    struct ggml_tensor * conv_out_t = ggml_graph_get_tensor(gf, "conv_out");
    std::vector<float> conv_all(n_state * conv_out_w * n_chunks);
    ggml_backend_tensor_get(conv_out_t, conv_all.data(), 0, conv_all.size() * sizeof(float));

    ggml_backend_sched_reset(state_.sched);
    ggml_free(ctx0);

    std::vector<float> pos_emb_data(max_out_w * n_state);
    compute_sinusoidal_pe(pos_emb_data.data(), max_out_w, n_state);

    std::vector<float> hidden_flat(total_out_frames * n_state);
    {
        int32_t dst_offset = 0;
        for (int32_t c = 0; c < n_chunks; ++c) {
            int32_t valid = chunk_out_lens[c];
            for (int32_t t = 0; t < valid; ++t) {
                for (int32_t d = 0; d < n_state; ++d) {
                    float val = conv_all[d + t * n_state + c * n_state * conv_out_w];
                    float pe = pos_emb_data[t * n_state + d];
                    hidden_flat[(dst_offset + t) * n_state + d] = val + pe;
                }
            }
            dst_offset += valid;
        }
    }

    // Windowed attention: process each window segment independently.
    //
    // The original code built a single graph with n_ctx = total_out_frames
    // (e.g. 4500 for 180s audio), producing attention scores of
    // n_head × n_ctx × n_ctx × 4B ≈ 1.3 GB and requiring ~3.5 GB total —
    // which exceeds CUDA pinned memory limits on Windows.
    //
    // Because attention is block-diagonal (windowed), segments are fully
    // independent. We process each segment with its own small graph
    // (seg_len = window_aftercnn ≈ 200), reducing peak attention memory
    // to n_head × 200 × 200 × 4B ≈ 2.5 MB. FFN layers are frame-level
    // (no cross-frame interaction), so segmenting is mathematically exact.
    const int32_t window_aftercnn = max_out_w * (n_window_infer / chunk_mel_size);

    std::vector<int32_t> cu_seqlens;
    cu_seqlens.push_back(0);
    {
        int32_t remaining = total_out_frames;
        while (remaining > 0) {
            if (remaining >= window_aftercnn) {
                cu_seqlens.push_back(cu_seqlens.back() + window_aftercnn);
                remaining -= window_aftercnn;
            } else {
                cu_seqlens.push_back(cu_seqlens.back() + remaining);
                remaining = 0;
            }
        }
    }

    const int n_state_out = hp.text_hidden_size;  // proj2 output dim
    output.resize(total_out_frames * n_state_out);

    for (size_t seg = 1; seg < cu_seqlens.size(); ++seg) {
        const int32_t seg_start = cu_seqlens[seg - 1];
        const int32_t seg_end = cu_seqlens[seg];
        const int32_t seg_len = seg_end - seg_start;

        ctx0 = ggml_init(params);
        gf = ggml_new_graph_custom(ctx0, QWEN3_FA_MAX_NODES, false);

        struct ggml_tensor * inp_hidden = ggml_new_tensor_2d(ctx0, GGML_TYPE_F32, n_state, seg_len);
        ggml_set_name(inp_hidden, "inp_hidden");
        ggml_set_input(inp_hidden);

        // All frames within a segment are mutually visible (the windowed
        // mask is realized by processing segments separately).
        struct ggml_tensor * mask_tensor = ggml_new_tensor_2d(ctx0, GGML_TYPE_F32, seg_len, seg_len);
        ggml_set_name(mask_tensor, "attn_mask");
        ggml_set_input(mask_tensor);

        struct ggml_tensor * inpL = inp_hidden;

        for (int il = 0; il < n_layer; ++il) {
            const auto & layer = model_.encoder_layers[il];

            cur = ggml_norm(ctx0, inpL, eps);
            if (layer.attn_norm_w) {
                cur = ggml_mul(ctx0, cur, layer.attn_norm_w);
            }
            if (layer.attn_norm_b) {
                cur = ggml_add(ctx0, cur, layer.attn_norm_b);
            }

            struct ggml_tensor * Qcur = ggml_mul_mat(ctx0, layer.attn_q_w, cur);
            if (layer.attn_q_b) Qcur = ggml_add(ctx0, Qcur, layer.attn_q_b);

            struct ggml_tensor * Kcur = ggml_mul_mat(ctx0, layer.attn_k_w, cur);
            if (layer.attn_k_b) Kcur = ggml_add(ctx0, Kcur, layer.attn_k_b);

            struct ggml_tensor * Vcur = ggml_mul_mat(ctx0, layer.attn_v_w, cur);
            if (layer.attn_v_b) Vcur = ggml_add(ctx0, Vcur, layer.attn_v_b);

            struct ggml_tensor * Q = ggml_permute(ctx0,
                ggml_reshape_3d(ctx0, Qcur, n_state_head, n_head, seg_len),
                0, 2, 1, 3);

            struct ggml_tensor * K = ggml_permute(ctx0,
                ggml_reshape_3d(ctx0, Kcur, n_state_head, n_head, seg_len),
                0, 2, 1, 3);

            struct ggml_tensor * KQ = ggml_mul_mat(ctx0, K, Q);

            struct ggml_tensor * KQ_soft_max = ggml_soft_max_ext(ctx0, KQ, mask_tensor, KQscale, 0.0f);

            struct ggml_tensor * V = ggml_cont(ctx0, ggml_permute(ctx0,
                ggml_reshape_3d(ctx0, Vcur, n_state_head, n_head, seg_len),
                1, 2, 0, 3));

            struct ggml_tensor * KQV = ggml_mul_mat(ctx0, V, KQ_soft_max);

            struct ggml_tensor * KQV_merged = ggml_permute(ctx0, KQV, 0, 2, 1, 3);

            cur = ggml_cont_2d(ctx0, KQV_merged, n_state, seg_len);

            cur = ggml_mul_mat(ctx0, layer.attn_out_w, cur);
            if (layer.attn_out_b) {
                cur = ggml_add(ctx0, cur, layer.attn_out_b);
            }

            cur = ggml_add(ctx0, cur, inpL);

            struct ggml_tensor * inpFF = cur;

            cur = ggml_norm(ctx0, inpFF, eps);
            if (layer.ffn_norm_w) {
                cur = ggml_mul(ctx0, cur, layer.ffn_norm_w);
            }
            if (layer.ffn_norm_b) {
                cur = ggml_add(ctx0, cur, layer.ffn_norm_b);
            }

            cur = ggml_mul_mat(ctx0, layer.ffn_up_w, cur);
            if (layer.ffn_up_b) {
                cur = ggml_add(ctx0, cur, layer.ffn_up_b);
            }

            cur = ggml_gelu(ctx0, cur);

            cur = ggml_mul_mat(ctx0, layer.ffn_down_w, cur);
            if (layer.ffn_down_b) {
                cur = ggml_add(ctx0, cur, layer.ffn_down_b);
            }

            inpL = ggml_add(ctx0, cur, inpFF);
        }

        cur = inpL;

        if (model_.ln_post_w) {
            cur = ggml_norm(ctx0, cur, eps);
            cur = ggml_mul(ctx0, cur, model_.ln_post_w);
            if (model_.ln_post_b) {
                cur = ggml_add(ctx0, cur, model_.ln_post_b);
            }
        }

        if (model_.proj1_w) {
            cur = ggml_mul_mat(ctx0, model_.proj1_w, cur);
            if (model_.proj1_b) {
                cur = ggml_add(ctx0, cur, model_.proj1_b);
            }
            cur = ggml_gelu(ctx0, cur);
        }

        if (model_.proj2_w) {
            cur = ggml_mul_mat(ctx0, model_.proj2_w, cur);
            if (model_.proj2_b) {
                cur = ggml_add(ctx0, cur, model_.proj2_b);
            }
        }

        ggml_set_name(cur, "audio_enc_out");
        ggml_set_output(cur);

        ggml_build_forward_expand(gf, cur);

        if (!ggml_backend_sched_alloc_graph(state_.sched, gf)) {
            error_msg_ = "Failed to allocate transformer graph for segment";
            ggml_free(ctx0);
            return false;
        }

        struct ggml_tensor * hidden_t = ggml_graph_get_tensor(gf, "inp_hidden");
        ggml_backend_tensor_set(hidden_t,
            hidden_flat.data() + (size_t)seg_start * n_state, 0,
            (size_t)seg_len * n_state * sizeof(float));

        std::vector<float> seg_mask((size_t)seg_len * seg_len, 0.0f);
        struct ggml_tensor * mask_t = ggml_graph_get_tensor(gf, "attn_mask");
        ggml_backend_tensor_set(mask_t, seg_mask.data(), 0,
            (size_t)seg_len * seg_len * sizeof(float));

        if (ggml_backend_sched_graph_compute(state_.sched, gf) != GGML_STATUS_SUCCESS) {
            error_msg_ = "Failed to compute transformer graph for segment";
            ggml_backend_sched_reset(state_.sched);
            ggml_free(ctx0);
            return false;
        }

        struct ggml_tensor * audio_out = ggml_graph_get_tensor(gf, "audio_enc_out");
        if (!audio_out) {
            error_msg_ = "Failed to find audio encoder output tensor";
            ggml_backend_sched_reset(state_.sched);
            ggml_free(ctx0);
            return false;
        }

        ggml_backend_tensor_get(audio_out,
            output.data() + (size_t)seg_start * n_state_out, 0,
            (size_t)seg_len * n_state_out * sizeof(float));

        ggml_backend_sched_reset(state_.sched);
        ggml_free(ctx0);
    }

    return true;
}

struct ggml_cgraph * ForcedAligner::build_decoder_graph(
    const int32_t * tokens, int32_t n_tokens,
    const float * audio_embd, int32_t n_audio,
    int32_t audio_start_pos) {
    
    const auto & hp = model_.hparams;
    const int n_head = hp.text_attention_heads;
    const int n_kv_head = hp.text_kv_heads;
    const int head_dim = hp.text_head_dim;
    const int hidden_size = hp.text_hidden_size;
    const float eps = hp.text_rms_norm_eps;
    const float rope_theta = hp.text_rope_theta;
    const int n_layer = hp.text_decoder_layers;
    
    struct ggml_init_params params = {
        /*.mem_size   =*/ state_.compute_meta.size(),
        /*.mem_buffer =*/ state_.compute_meta.data(),
        /*.no_alloc   =*/ true,
    };
    
    struct ggml_context * ctx0 = ggml_init(params);
    struct ggml_cgraph * gf = ggml_new_graph_custom(ctx0, QWEN3_FA_MAX_NODES, false);
    
    struct ggml_tensor * inp_tokens = ggml_new_tensor_1d(ctx0, GGML_TYPE_I32, n_tokens);
    ggml_set_name(inp_tokens, "inp_tokens");
    ggml_set_input(inp_tokens);
    
    struct ggml_tensor * inp_pos = ggml_new_tensor_1d(ctx0, GGML_TYPE_I32, n_tokens);
    ggml_set_name(inp_pos, "inp_pos");
    ggml_set_input(inp_pos);
    
    struct ggml_tensor * inp_audio = nullptr;
    if (audio_embd && n_audio > 0) {
        inp_audio = ggml_new_tensor_2d(ctx0, GGML_TYPE_F32, hidden_size, n_audio);
        ggml_set_name(inp_audio, "inp_audio");
        ggml_set_input(inp_audio);
    }
    
    struct ggml_tensor * cur = ggml_get_rows(ctx0, model_.token_embd, inp_tokens);
    
    if (inp_audio && n_audio > 0 && audio_start_pos >= 0 && audio_start_pos + n_audio <= n_tokens) {
        struct ggml_tensor * embd_before = nullptr;
        struct ggml_tensor * embd_after = nullptr;
        
        if (audio_start_pos > 0) {
            embd_before = ggml_view_2d(ctx0, cur, hidden_size, audio_start_pos,
                                       cur->nb[1], 0);
        }
        
        if (audio_start_pos + n_audio < n_tokens) {
            int after_start = audio_start_pos + n_audio;
            int after_len = n_tokens - after_start;
            embd_after = ggml_view_2d(ctx0, cur, hidden_size, after_len,
                                      cur->nb[1], after_start * cur->nb[1]);
        }
        
        if (embd_before && embd_after) {
            struct ggml_tensor * tmp = ggml_concat(ctx0, embd_before, inp_audio, 1);
            cur = ggml_concat(ctx0, tmp, embd_after, 1);
        } else if (embd_before) {
            cur = ggml_concat(ctx0, embd_before, inp_audio, 1);
        } else if (embd_after) {
            cur = ggml_concat(ctx0, inp_audio, embd_after, 1);
        } else {
            cur = inp_audio;
        }
    }
    
    struct ggml_tensor * inpL = cur;
    
    const float KQscale = 1.0f / sqrtf(float(head_dim));
    
    struct ggml_tensor * causal_mask = ggml_new_tensor_2d(ctx0, GGML_TYPE_F16, n_tokens, n_tokens);
    ggml_set_name(causal_mask, "causal_mask");
    ggml_set_input(causal_mask);
    
    for (int il = 0; il < n_layer; ++il) {
        const auto & layer = model_.decoder_layers[il];
        
        if (!layer.attn_norm || !layer.attn_q || !layer.attn_k || !layer.attn_v || 
            !layer.attn_output || !layer.ffn_norm || !layer.ffn_gate || 
            !layer.ffn_up || !layer.ffn_down) {
            ggml_free(ctx0);
            return nullptr;
        }
        
        cur = ggml_rms_norm(ctx0, inpL, eps);
        cur = ggml_mul(ctx0, cur, layer.attn_norm);
        
        struct ggml_tensor * Qcur = ggml_mul_mat(ctx0, layer.attn_q, cur);
        struct ggml_tensor * Kcur = ggml_mul_mat(ctx0, layer.attn_k, cur);
        struct ggml_tensor * Vcur = ggml_mul_mat(ctx0, layer.attn_v, cur);
        
        Qcur = ggml_reshape_3d(ctx0, Qcur, head_dim, n_head, n_tokens);
        Kcur = ggml_reshape_3d(ctx0, Kcur, head_dim, n_kv_head, n_tokens);
        Vcur = ggml_reshape_3d(ctx0, Vcur, head_dim, n_kv_head, n_tokens);
        
        if (layer.attn_q_norm) {
            Qcur = ggml_rms_norm(ctx0, Qcur, eps);
            Qcur = ggml_mul(ctx0, Qcur, layer.attn_q_norm);
        }
        
        if (layer.attn_k_norm) {
            Kcur = ggml_rms_norm(ctx0, Kcur, eps);
            Kcur = ggml_mul(ctx0, Kcur, layer.attn_k_norm);
        }
        
        Qcur = ggml_rope_ext(ctx0, Qcur, inp_pos, nullptr,
                             head_dim, GGML_ROPE_TYPE_NEOX, 0,
                             rope_theta, 1.0f, 0.0f, 1.0f, 0.0f, 0.0f);
        
        Kcur = ggml_rope_ext(ctx0, Kcur, inp_pos, nullptr,
                             head_dim, GGML_ROPE_TYPE_NEOX, 0,
                             rope_theta, 1.0f, 0.0f, 1.0f, 0.0f, 0.0f);
        
        struct ggml_tensor * Qfa = ggml_permute(ctx0, Qcur, 0, 2, 1, 3);
        struct ggml_tensor * Kfa = ggml_permute(ctx0, Kcur, 0, 2, 1, 3);
        struct ggml_tensor * Vfa = ggml_cast(ctx0, ggml_permute(ctx0, Vcur, 0, 2, 1, 3), GGML_TYPE_F16);
        
        cur = ggml_flash_attn_ext(ctx0, Qfa, Kfa, Vfa, causal_mask, KQscale, 0.0f, 0.0f);
        ggml_flash_attn_ext_set_prec(cur, GGML_PREC_F32);
        cur = ggml_reshape_2d(ctx0, cur, n_head * head_dim, n_tokens);
        
        cur = ggml_mul_mat(ctx0, layer.attn_output, cur);
        cur = ggml_add(ctx0, cur, inpL);
        struct ggml_tensor * inpFF = cur;
        
        cur = ggml_rms_norm(ctx0, inpFF, eps);
        cur = ggml_mul(ctx0, cur, layer.ffn_norm);
        
        struct ggml_tensor * gate = ggml_mul_mat(ctx0, layer.ffn_gate, cur);
        struct ggml_tensor * up = ggml_mul_mat(ctx0, layer.ffn_up, cur);
        
        gate = ggml_silu(ctx0, gate);
        
        cur = ggml_mul(ctx0, gate, up);
        
        cur = ggml_mul_mat(ctx0, layer.ffn_down, cur);
        
        inpL = ggml_add(ctx0, cur, inpFF);
    }
    
    cur = inpL;
    
    cur = ggml_rms_norm(ctx0, cur, eps);
    cur = ggml_mul(ctx0, cur, model_.output_norm);
    
    cur = ggml_mul_mat(ctx0, model_.classify_head_w, cur);
    if (model_.classify_head_b) {
        cur = ggml_add(ctx0, cur, model_.classify_head_b);
    }
    
    ggml_set_name(cur, "logits");
    ggml_set_output(cur);
    
    ggml_build_forward_expand(gf, cur);
    
    ggml_free(ctx0);
    
    return gf;
}

bool ForcedAligner::forward_decoder(
    const int32_t * tokens, int32_t n_tokens,
    const float * audio_embd, int32_t n_audio,
    int32_t audio_start_pos,
    std::vector<float> & output) {
    
    if (!model_.ctx) {
        error_msg_ = "Model not loaded";
        return false;
    }
    
    struct ggml_cgraph * gf = build_decoder_graph(tokens, n_tokens,
                                                   audio_embd, n_audio, audio_start_pos);
    if (!gf) {
        error_msg_ = "Failed to build decoder graph";
        return false;
    }
    
    if (!ggml_backend_sched_alloc_graph(state_.sched, gf)) {
        error_msg_ = "Failed to allocate graph";
        return false;
    }
    
    struct ggml_tensor * inp_tokens = ggml_graph_get_tensor(gf, "inp_tokens");
    if (!inp_tokens) {
        error_msg_ = "Failed to find inp_tokens tensor";
        ggml_backend_sched_reset(state_.sched);
        return false;
    }
    ggml_backend_tensor_set(inp_tokens, tokens, 0, n_tokens * sizeof(int32_t));
    
    struct ggml_tensor * inp_pos = ggml_graph_get_tensor(gf, "inp_pos");
    if (inp_pos) {
        std::vector<int32_t> positions(n_tokens);
        for (int i = 0; i < n_tokens; ++i) {
            positions[i] = i;
        }
        ggml_backend_tensor_set(inp_pos, positions.data(), 0, n_tokens * sizeof(int32_t));
    }
    
    struct ggml_tensor * mask_t = ggml_graph_get_tensor(gf, "causal_mask");
    if (mask_t) {
        std::vector<ggml_fp16_t> mask_data((size_t)n_tokens * n_tokens);
        const ggml_fp16_t zero_f16 = ggml_fp32_to_fp16(0.0f);
        const ggml_fp16_t neginf_f16 = ggml_fp32_to_fp16(-INFINITY);
        for (int q = 0; q < n_tokens; ++q) {
            for (int k = 0; k < n_tokens; ++k) {
                mask_data[k + q * n_tokens] = (k <= q) ? zero_f16 : neginf_f16;
            }
        }
        ggml_backend_tensor_set(mask_t, mask_data.data(), 0, mask_data.size() * sizeof(ggml_fp16_t));
    }
    
    if (audio_embd && n_audio > 0) {
        struct ggml_tensor * inp_audio = ggml_graph_get_tensor(gf, "inp_audio");
        if (inp_audio) {
            ggml_backend_tensor_set(inp_audio, audio_embd, 0, 
                                    n_audio * model_.hparams.text_hidden_size * sizeof(float));
        }
    }
    
    if (ggml_backend_sched_graph_compute(state_.sched, gf) != GGML_STATUS_SUCCESS) {
        error_msg_ = "Failed to compute graph";
        ggml_backend_sched_reset(state_.sched);
        return false;
    }
    
    struct ggml_tensor * logits = ggml_graph_get_tensor(gf, "logits");
    if (!logits) {
        error_msg_ = "Failed to find logits tensor";
        ggml_backend_sched_reset(state_.sched);
        return false;
    }
    
    int64_t n_classes = logits->ne[0];
    output.resize(n_tokens * n_classes);
    ggml_backend_tensor_get(logits, output.data(), 0, output.size() * sizeof(float));
    
    ggml_backend_sched_reset(state_.sched);
    
    return true;
}

// Ported from HF _get_feat_extract_output_lengths in processing_qwen3_asr.py
// Computes number of audio_pad tokens from mel spectrogram frame count.
static int32_t get_feat_extract_output_lengths(int32_t input_lengths) {
    int32_t input_lengths_leave = input_lengths % 100;
    int32_t feat_lengths = (input_lengths_leave - 1) / 2 + 1;
    int32_t output_lengths = ((feat_lengths - 1) / 2 + 1 - 1) / 2 + 1 + (input_lengths / 100) * 13;
    return output_lengths;
}

// LIS-based timestamp correction: finds longest increasing subsequence,
// then interpolates anomalous values between nearest valid neighbors.
// Ported from HF Qwen3ForcedAligner.fix_timestamp()
std::vector<int32_t> ForcedAligner::fix_timestamp_classes(const std::vector<int32_t> & data) {
    const int n = static_cast<int>(data.size());
    if (n == 0) return {};

    std::vector<int> dp(n, 1);
    std::vector<int> parent(n, -1);

    for (int i = 1; i < n; ++i) {
        for (int j = 0; j < i; ++j) {
            if (data[j] <= data[i] && dp[j] + 1 > dp[i]) {
                dp[i] = dp[j] + 1;
                parent[i] = j;
            }
        }
    }

    int max_len = 0, max_idx = 0;
    for (int i = 0; i < n; ++i) {
        if (dp[i] > max_len) {
            max_len = dp[i];
            max_idx = i;
        }
    }

    std::vector<bool> is_normal(n, false);
    {
        int idx = max_idx;
        while (idx != -1) {
            is_normal[idx] = true;
            idx = parent[idx];
        }
    }

    std::vector<int32_t> result(data.begin(), data.end());
    int i = 0;

    while (i < n) {
        if (!is_normal[i]) {
            int j = i;
            while (j < n && !is_normal[j]) ++j;
            int anomaly_count = j - i;

            int32_t left_val = -1;
            for (int k = i - 1; k >= 0; --k) {
                if (is_normal[k]) { left_val = result[k]; break; }
            }

            int32_t right_val = -1;
            for (int k = j; k < n; ++k) {
                if (is_normal[k]) { right_val = result[k]; break; }
            }

            if (anomaly_count <= 2) {
                for (int k = i; k < j; ++k) {
                    if (left_val < 0) {
                        result[k] = right_val;
                    } else if (right_val < 0) {
                        result[k] = left_val;
                    } else {
                        result[k] = ((k - (i - 1)) <= (j - k)) ? left_val : right_val;
                    }
                }
            } else {
                if (left_val >= 0 && right_val >= 0) {
                    float step = static_cast<float>(right_val - left_val) / (anomaly_count + 1);
                    for (int k = i; k < j; ++k) {
                        result[k] = static_cast<int32_t>(left_val + step * (k - i + 1));
                    }
                } else if (left_val >= 0) {
                    for (int k = i; k < j; ++k) result[k] = left_val;
                } else if (right_val >= 0) {
                    for (int k = i; k < j; ++k) result[k] = right_val;
                }
            }

            i = j;
        } else {
            ++i;
        }
    }

    return result;
}

std::vector<float> ForcedAligner::classes_to_timestamps(const std::vector<int32_t> & classes) {
    std::vector<float> timestamps;
    timestamps.reserve(classes.size());
    
    float segment_time_sec = model_.hparams.timestamp_segment_time_ms / 1000.0f;
    
    for (int32_t cls : classes) {
        timestamps.push_back(cls * segment_time_sec);
    }
    
    return timestamps;
}

std::vector<int32_t> ForcedAligner::extract_timestamp_classes(
    const std::vector<float> & logits,
    const std::vector<int32_t> & tokens,
    int32_t timestamp_token_id) {
    
    const int32_t n_classes = model_.hparams.classify_num;
    std::vector<int32_t> timestamp_classes;
    
    for (size_t i = 0; i < tokens.size(); ++i) {
        if (tokens[i] == timestamp_token_id) {
            const float * logit_ptr = logits.data() + i * n_classes;
            
            int32_t best_class = 0;
            float best_score = logit_ptr[0];
            for (int32_t c = 1; c < n_classes; ++c) {
                if (logit_ptr[c] > best_score) {
                    best_score = logit_ptr[c];
                    best_class = c;
                }
            }
            
            timestamp_classes.push_back(best_class);
        }
    }
    
    return timestamp_classes;
}

std::vector<int32_t> ForcedAligner::build_input_tokens(
    const std::vector<int32_t> & text_tokens,
    int32_t n_audio_frames) {
    
    const auto & hp = model_.hparams;
    
    std::vector<int32_t> tokens;
    tokens.reserve(n_audio_frames + text_tokens.size() + 3);
    
    // No chat template — just: <audio_start><pad>...<pad><audio_end><text_tokens>
    tokens.push_back(hp.audio_start_token_id);
    for (int32_t i = 0; i < n_audio_frames; ++i) {
        tokens.push_back(hp.audio_pad_token_id);
    }
    tokens.push_back(hp.audio_end_token_id);
    
    for (int32_t tok : text_tokens) {
        tokens.push_back(tok);
    }
    
    return tokens;
}

int32_t ForcedAligner::find_audio_start_pos(const std::vector<int32_t> & tokens) {
    for (size_t i = 0; i < tokens.size(); ++i) {
        if (tokens[i] == model_.hparams.audio_start_token_id) {
            return static_cast<int32_t>(i + 1);
        }
    }
    return -1;
}

// GPT-2 byte-to-unicode: maps each byte value to a Unicode codepoint.
// Printable bytes map to themselves; non-printable bytes map to 256+n.
static const std::vector<std::string> & get_byte_to_unicode_table() {
    static std::vector<std::string> table;
    if (!table.empty()) return table;
    table.resize(256);

    std::vector<int> byte_to_cp(256, 0);
    std::vector<bool> assigned(256, false);

    auto mark = [&](int lo, int hi) {
        for (int b = lo; b <= hi; ++b) {
            byte_to_cp[b] = b;
            assigned[b] = true;
        }
    };
    mark(0x21, 0x7E);
    mark(0xA1, 0xAC);
    mark(0xAE, 0xFF);

    int n = 0;
    for (int b = 0; b < 256; ++b) {
        if (!assigned[b]) {
            byte_to_cp[b] = 256 + n;
            ++n;
        }
    }

    auto cp_to_utf8 = [](int cp) -> std::string {
        std::string s;
        if (cp < 0x80) {
            s += static_cast<char>(cp);
        } else if (cp < 0x800) {
            s += static_cast<char>(0xC0 | (cp >> 6));
            s += static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            s += static_cast<char>(0xE0 | (cp >> 12));
            s += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            s += static_cast<char>(0x80 | (cp & 0x3F));
        }
        return s;
    };

    for (int b = 0; b < 256; ++b) {
        table[b] = cp_to_utf8(byte_to_cp[b]);
    }
    return table;
}

static std::string bytes_to_bpe_string(const std::string & text) {
    const auto & table = get_byte_to_unicode_table();
    std::string result;
    result.reserve(text.size() * 2);
    for (unsigned char c : text) {
        result += table[c];
    }
    return result;
}

static std::vector<std::string> split_utf8_chars(const std::string & s) {
    std::vector<std::string> chars;
    size_t i = 0;
    while (i < s.size()) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        size_t len = 1;
        if ((c & 0xE0) == 0xC0) len = 2;
        else if ((c & 0xF0) == 0xE0) len = 3;
        else if ((c & 0xF8) == 0xF0) len = 4;
        if (i + len > s.size()) len = 1;
        chars.push_back(s.substr(i, len));
        i += len;
    }
    return chars;
}

static std::vector<std::string> bpe_encode_word(
    const std::string & word_bpe,
    const std::unordered_map<std::string, int> & bpe_ranks) {

    std::vector<std::string> symbols = split_utf8_chars(word_bpe);
    if (symbols.size() <= 1) return symbols;

    while (true) {
        int best_rank = INT_MAX;
        size_t best_pos = 0;

        for (size_t i = 0; i + 1 < symbols.size(); ++i) {
            std::string key = symbols[i] + " " + symbols[i + 1];
            auto it = bpe_ranks.find(key);
            if (it != bpe_ranks.end() && it->second < best_rank) {
                best_rank = it->second;
                best_pos = i;
            }
        }

        if (best_rank == INT_MAX) break;

        std::string merged = symbols[best_pos] + symbols[best_pos + 1];
        std::vector<std::string> new_symbols;
        new_symbols.reserve(symbols.size() - 1);
        for (size_t i = 0; i < symbols.size(); ++i) {
            if (i == best_pos) {
                new_symbols.push_back(merged);
                ++i;
            } else {
                new_symbols.push_back(symbols[i]);
            }
        }
        symbols = std::move(new_symbols);
        if (symbols.size() == 1) break;
    }

    return symbols;
}

static size_t utf8_char_len(unsigned char c) {
    if ((c & 0x80) == 0) return 1;
    if ((c & 0xE0) == 0xC0) return 2;
    if ((c & 0xF0) == 0xE0) return 3;
    if ((c & 0xF8) == 0xF0) return 4;
    return 1;
}

static size_t utf8_strlen(const std::string & s) {
    size_t count = 0;
    size_t i = 0;
    while (i < s.size()) {
        i += utf8_char_len(static_cast<unsigned char>(s[i]));
        ++count;
    }
    return count;
}

static std::string utf8_substr(const std::string & s, size_t char_start, size_t char_count) {
    size_t byte_start = 0;
    for (size_t c = 0; c < char_start && byte_start < s.size(); ++c) {
        byte_start += utf8_char_len(static_cast<unsigned char>(s[byte_start]));
    }
    size_t byte_end = byte_start;
    for (size_t c = 0; c < char_count && byte_end < s.size(); ++c) {
        byte_end += utf8_char_len(static_cast<unsigned char>(s[byte_end]));
    }
    return s.substr(byte_start, byte_end - byte_start);
}

std::vector<std::string> tokenize_korean(const std::string & text,
                                          const std::unordered_set<std::string> & ko_dict) {
    const float default_score = 0.0f;

    std::vector<std::string> whitespace_words;
    {
        size_t i = 0;
        while (i < text.size()) {
            while (i < text.size() && (text[i] == ' ' || text[i] == '\t' ||
                                        text[i] == '\n' || text[i] == '\r')) ++i;
            if (i >= text.size()) break;
            size_t start = i;
            while (i < text.size() && text[i] != ' ' && text[i] != '\t' &&
                   text[i] != '\n' && text[i] != '\r') ++i;
            whitespace_words.push_back(text.substr(start, i - start));
        }
    }

    std::vector<std::string> result;

    for (const auto & word : whitespace_words) {
        size_t length = utf8_strlen(word);
        if (length <= 2) {
            result.push_back(word);
            continue;
        }

        float best_score = -1e9f;
        size_t best_left_len = 0;
        std::string best_left;
        std::string best_right;

        for (size_t e = 2; e <= length; ++e) {
            std::string left = utf8_substr(word, 0, e);
            std::string right = utf8_substr(word, e, length - e);

            float score = default_score;
            if (ko_dict.count(left)) {
                score = 1.0f;
            }

            if (score > best_score || (score == best_score && e > best_left_len)) {
                best_score = score;
                best_left_len = e;
                best_left = left;
                best_right = right;
            }
        }

        result.push_back(best_left);
        if (!best_right.empty()) {
            result.push_back(best_right);
        }
    }

    return result;
}

bool ForcedAligner::load_korean_dict(const std::string & dict_path) {
    std::ifstream f(dict_path);
    if (!f.is_open()) {
        return false;
    }

    model_.ko_dict.clear();
    std::string line;
    while (std::getline(f, line)) {
        if (line.empty()) continue;
        size_t pos = line.find(' ');
        std::string word = (pos != std::string::npos) ? line.substr(0, pos) : line;
        if (!word.empty()) {
            model_.ko_dict.insert(word);
        }
    }

    fprintf(stderr, "Korean dictionary loaded: %zu words\n", model_.ko_dict.size());
    return true;
}

// Decode one UTF-8 codepoint starting at index i; advance i past the char.
// Returns the codepoint, or 0 on end-of-string. Tolerates truncated sequences.
static uint32_t decode_utf8(const std::string & s, size_t & i) {
    if (i >= s.size()) return 0;
    unsigned char c = (unsigned char)s[i];
    if (c < 0x80) { i += 1; return c; }
    if ((c & 0xE0) == 0xC0 && i + 1 < s.size()) {
        uint32_t cp = (uint32_t)(c & 0x1F) << 6 | ((unsigned char)s[i + 1] & 0x3F);
        i += 2; return cp;
    }
    if ((c & 0xF0) == 0xE0 && i + 2 < s.size()) {
        uint32_t cp = (uint32_t)(c & 0x0F) << 12 |
                      ((unsigned char)s[i + 1] & 0x3F) << 6 |
                      ((unsigned char)s[i + 2] & 0x3F);
        i += 3; return cp;
    }
    if ((c & 0xF8) == 0xF0 && i + 3 < s.size()) {
        uint32_t cp = (uint32_t)(c & 0x07) << 18 |
                      ((unsigned char)s[i + 1] & 0x3F) << 12 |
                      ((unsigned char)s[i + 2] & 0x3F) << 6 |
                      ((unsigned char)s[i + 3] & 0x3F);
        i += 4; return cp;
    }
    i += 1; return c;
}

// True if the codepoint is a CJK ideograph / kana / hangul — i.e. a character
// that the ForcedAligner should split into its own per-character timestamp.
static bool is_cjk_codepoint(uint32_t cp) {
    return (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs
           (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Extension A
           (cp >= 0x20000 && cp <= 0x2A6DF) || // CJK Extension B
           (cp >= 0x2A700 && cp <= 0x2B73F) || // CJK Extension C
           (cp >= 0x2B740 && cp <= 0x2B81F) || // CJK Extension D
           (cp >= 0x3040 && cp <= 0x309F) ||   // Hiragana
           (cp >= 0x30A0 && cp <= 0x30FF) ||   // Katakana
           (cp >= 0xAC00 && cp <= 0xD7AF) ||   // Hangul Syllables
           (cp >= 0xF900 && cp <= 0xFAFF);     // CJK Compatibility Ideographs
}

// First codepoint of a UTF-8 string (0 if empty).
static uint32_t first_codepoint(const std::string & s) {
    size_t i = 0;
    return decode_utf8(s, i);
}

// Split a raw word into per-character CJK sub-words and contiguous ASCII
// sub-words. E.g. "小怪怪Hello世界" → ["小","怪","怪","Hello","世","界"].
// Each returned sub-word is a UTF-8 byte sequence (one CJK char or a run of
// non-CJK bytes). Punctuation is preserved here; strip_word_punctuation is
// applied per sub-word by the caller.
static std::vector<std::string> split_by_cjk(const std::string & word) {
    std::vector<std::string> result;
    std::string ascii_run;
    size_t i = 0;
    while (i < word.size()) {
        size_t start = i;
        uint32_t cp = decode_utf8(word, i);
        std::string ch = word.substr(start, i - start);
        if (is_cjk_codepoint(cp)) {
            if (!ascii_run.empty()) { result.push_back(ascii_run); ascii_run.clear(); }
            result.push_back(ch);
        } else {
            ascii_run += ch;
        }
    }
    if (!ascii_run.empty()) result.push_back(ascii_run);
    return result;
}

// Strip leading and trailing ASCII punctuation from a word, returning the
// alphabetic/numeric core. Punctuation has no corresponding audio frames, so
// including it in the BPE sequence fed to the forced aligner biases the
// timestamp predictions and causes misalignment.
static std::string strip_word_punctuation(const std::string & word) {
    // Characters that are purely punctuation / non-speech.
    auto is_punct = [](unsigned char c) -> bool {
        // Keep letters, digits, and non-ASCII bytes (CJK, accented chars, …).
        if (c > 0x7F) return false;
        return !std::isalnum(c);
    };

    size_t start = 0;
    while (start < word.size() && is_punct(static_cast<unsigned char>(word[start]))) {
        ++start;
    }
    size_t end = word.size();
    while (end > start && is_punct(static_cast<unsigned char>(word[end - 1]))) {
        --end;
    }
    return word.substr(start, end - start);
}

std::vector<int32_t> ForcedAligner::tokenize_with_timestamps(
    const std::string & text,
    std::vector<std::string> & words,
    const std::string & language) {

    words.clear();
    std::vector<int32_t> tokens;

    std::vector<std::string> raw_words;

    if (language == "korean" && !model_.ko_dict.empty()) {
        raw_words = tokenize_korean(text, model_.ko_dict);
    } else {
        size_t i = 0;
        while (i < text.size()) {
            while (i < text.size() && (text[i] == ' ' || text[i] == '\t' ||
                                        text[i] == '\n' || text[i] == '\r')) ++i;
            if (i >= text.size()) break;
            size_t start = i;
            while (i < text.size() && text[i] != ' ' && text[i] != '\t' &&
                   text[i] != '\n' && text[i] != '\r') ++i;
            raw_words.push_back(text.substr(start, i - start));
        }
    }

    bool first_word = true;
    for (size_t w = 0; w < raw_words.size(); ++w) {
        // Split CJK characters into individual words (one timestamp pair per
        // character); ASCII runs stay as single words. E.g. "小怪怪的肚子饿"
        // → 7 words each with its own start/end timestamp, "Hello" → 1 word.
        auto sub_words = split_by_cjk(raw_words[w]);
        for (const auto & sw : sub_words) {
            // Strip leading/trailing punctuation for BPE encoding; punctuation
            // has no audio content and was not part of the model's training format.
            std::string clean = strip_word_punctuation(sw);
            if (clean.empty()) {
                // Pure-punctuation sub-word — skip entirely so that the
                // words[] / timestamp-pair counts stay in sync.
                continue;
            }

            // Preserve the original surface form (with punctuation) in the output.
            words.push_back(sw);

            // CJK chars don't use a leading space in the Qwen3 vocab (their
            // BPE tokens exist without the 'Ġ' prefix). ASCII words need the
            // leading space (encoded as 'Ġ') when they are not the first word,
            // otherwise the token ID may be missing and silently dropped.
            bool sw_is_cjk = is_cjk_codepoint(first_codepoint(clean));
            std::string to_encode;
            if (sw_is_cjk || first_word) {
                to_encode = clean;
            } else {
                to_encode = " " + clean;
            }
            first_word = false;

            std::string bpe_str = bytes_to_bpe_string(to_encode);
            std::vector<std::string> subwords = bpe_encode_word(bpe_str, model_.bpe_ranks);

            for (const auto & s : subwords) {
                auto it = model_.token_to_id.find(s);
                if (it != model_.token_to_id.end()) {
                    tokens.push_back(it->second);
                } else {
                    fprintf(stderr, "BPE tokenizer: unknown subword token '%s'\n", s.c_str());
                }
            }

            tokens.push_back(model_.hparams.timestamp_token_id);
            tokens.push_back(model_.hparams.timestamp_token_id);
        }
    }

    return tokens;
}

alignment_result ForcedAligner::align(const std::string & audio_path, const std::string & text,
                                       const std::string & language) {
    alignment_result result;

    FA_LOGF("align(file): audio=%s, text_len=%zu, lang=%s",
            audio_path.c_str(), text.size(), language.c_str());

    if (!model_loaded_) {
        result.error_msg = "Model not loaded";
        FA_LOG("align(file): model not loaded");
        return result;
    }

    std::vector<float> samples;
    int sample_rate;

    FA_LOG("align(file): load_wav...");
    if (!load_wav(audio_path, samples, sample_rate)) {
        result.error_msg = "Failed to load audio file: " + audio_path;
        FA_LOGF("align(file): load_wav FAILED: %s", result.error_msg.c_str());
        return result;
    }
    FA_LOGF("align(file): load_wav OK: %zu samples, %d Hz", samples.size(), sample_rate);

    if (sample_rate != QWEN_SAMPLE_RATE) {
        result.error_msg = "Audio must be 16kHz, got " + std::to_string(sample_rate) + " Hz";
        FA_LOGF("align(file): sample rate mismatch: %s", result.error_msg.c_str());
        return result;
    }

    FA_LOG("align(file): delegating to align(samples)...");
    return align(samples.data(), samples.size(), text, language);
}

alignment_result ForcedAligner::align(const float * samples, int n_samples, const std::string & text,
                                       const std::string & language) {
    alignment_result result;
    int64_t t_total_start = get_time_ms();

    FA_LOGF("align(samples): n_samples=%d, text_len=%zu", n_samples, text.size());

    if (!model_loaded_) {
        result.error_msg = "Model not loaded";
        return result;
    }

    float audio_duration = static_cast<float>(n_samples) / QWEN_SAMPLE_RATE;
    FA_LOGF("align: audio_duration=%.2fs", audio_duration);

    int64_t t_mel_start = get_time_ms();
    FA_LOG("align: generate_mel_filters...");
    MelFilters mel_filters;
    generate_mel_filters(mel_filters, QWEN_N_MELS, QWEN_N_FFT, QWEN_SAMPLE_RATE);

    FA_LOG("align: log_mel_spectrogram...");
    MelSpectrogram mel;
    if (!log_mel_spectrogram(samples, n_samples, mel_filters, mel, 4)) {
        result.error_msg = "Failed to compute mel spectrogram";
        FA_LOG("align: log_mel_spectrogram FAILED");
        return result;
    }
    result.t_mel_ms = get_time_ms() - t_mel_start;
    FA_LOGF("align: mel OK: n_mel=%d, n_len=%d (%lldms)", mel.n_mel, mel.n_len, (long long)result.t_mel_ms);

    int64_t t_encode_start = get_time_ms();
    FA_LOG("align: encode_audio...");
    std::vector<float> audio_features;
    if (!encode_audio(mel.data.data(), mel.n_mel, mel.n_len, audio_features)) {
        result.error_msg = "Failed to encode audio: " + error_msg_;
        FA_LOGF("align: encode_audio FAILED: %s", result.error_msg.c_str());
        return result;
    }
    result.t_encode_ms = get_time_ms() - t_encode_start;
    FA_LOGF("align: encode OK: %zu features (%lldms)", audio_features.size(), (long long)result.t_encode_ms);

    int32_t n_audio_frames = audio_features.size() / model_.hparams.text_hidden_size;

    // Compute pad count using HF's _get_feat_extract_output_lengths formula
    int32_t n_audio_pads = get_feat_extract_output_lengths(mel.n_len);

    std::vector<std::string> words;
    std::vector<int32_t> text_tokens = tokenize_with_timestamps(text, words, language);

    std::vector<int32_t> input_tokens = build_input_tokens(text_tokens, n_audio_pads);

    int32_t audio_start_pos = find_audio_start_pos(input_tokens);

    FA_LOGF("align: decode: n_frames=%d, n_pads=%d, input_tokens=%zu, audio_start=%d",
            n_audio_frames, n_audio_pads, input_tokens.size(), audio_start_pos);

    int64_t t_decode_start = get_time_ms();
    FA_LOG("align: forward_decoder...");
    std::vector<float> logits;
    if (!forward_decoder(input_tokens.data(), input_tokens.size(),
                         audio_features.data(), n_audio_frames,
                         audio_start_pos, logits)) {
        result.error_msg = "Decoder forward pass failed: " + error_msg_;
        FA_LOGF("align: forward_decoder FAILED: %s", result.error_msg.c_str());
        return result;
    }
    result.t_decode_ms = get_time_ms() - t_decode_start;
    FA_LOGF("align: decode OK: %zu logits (%lldms)", logits.size(), (long long)result.t_decode_ms);
    
    std::vector<int32_t> timestamp_classes = extract_timestamp_classes(
        logits, input_tokens, model_.hparams.timestamp_token_id);
    
    std::vector<int32_t> fixed_classes = fix_timestamp_classes(timestamp_classes);
    
    std::vector<float> timestamps = classes_to_timestamps(fixed_classes);
    
    for (size_t i = 0; i < timestamps.size(); ++i) {
        if (timestamps[i] > audio_duration) {
            timestamps[i] = audio_duration;
        }
    }
    
    // 2 timestamps per word: ts[2i] = start, ts[2i+1] = end
    for (size_t i = 0; i < words.size(); ++i) {
        aligned_word aw;
        aw.word = words[i];
        
        size_t start_idx = i * 2;
        size_t end_idx = i * 2 + 1;
        
        aw.start = (start_idx < timestamps.size()) ? timestamps[start_idx] : 0.0f;
        aw.end = (end_idx < timestamps.size()) ? timestamps[end_idx] : audio_duration;
        
        result.words.push_back(aw);
    }
    
    result.success = true;
    result.t_total_ms = get_time_ms() - t_total_start;
    
    return result;
}

void free_forced_aligner_model(forced_aligner_model & model) {
    if (model.buffer) {
        ggml_backend_buffer_free(model.buffer);
        model.buffer = nullptr;
    }
    if (model.ctx) {
        ggml_free(model.ctx);
        model.ctx = nullptr;
    }
    if (model.mmap_addr) {
#ifdef _WIN32
        UnmapViewOfFile(model.mmap_addr);
#else
        munmap(model.mmap_addr, model.mmap_size);
#endif
        model.mmap_addr = nullptr;
        model.mmap_size = 0;
    }
    model.tensors.clear();
    model.encoder_layers.clear();
    model.decoder_layers.clear();
    model.vocab.clear();
    model.ko_dict.clear();
}

std::vector<int32_t> simple_tokenize(const std::string & text,
                                      const std::vector<std::string> & vocab,
                                      std::vector<std::string> & words) {
    words.clear();
    std::vector<int32_t> tokens;

    std::unordered_map<std::string, int32_t> tok_map;
    for (size_t i = 0; i < vocab.size(); ++i) {
        tok_map[vocab[i]] = static_cast<int32_t>(i);
    }

    std::istringstream iss(text);
    std::string word;
    bool first = true;

    while (iss >> word) {
        words.push_back(word);
        std::string to_encode = first ? word : (" " + word);
        first = false;
        std::string bpe_str = bytes_to_bpe_string(to_encode);
        std::vector<std::string> subwords = bpe_encode_word(bpe_str, {});
        for (const auto & sw : subwords) {
            auto it = tok_map.find(sw);
            if (it != tok_map.end()) {
                tokens.push_back(it->second);
            }
        }
    }

    return tokens;
}

}
