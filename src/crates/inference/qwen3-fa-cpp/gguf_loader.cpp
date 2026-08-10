#include "gguf_loader.h"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

namespace qwen3_asr {

GGUFLoader::GGUFLoader() = default;

GGUFLoader::~GGUFLoader() = default;

bool GGUFLoader::load(const std::string & path, audio_encoder_model & model) {
    struct ggml_context * meta_ctx = nullptr;
    struct gguf_init_params params = {
        /*.no_alloc =*/ true,
        /*.ctx      =*/ &meta_ctx,
    };
    
    struct gguf_context * ctx = gguf_init_from_file(path.c_str(), params);
    if (!ctx) {
        error_msg_ = "Failed to open GGUF file: " + path;
        return false;
    }
    
    if (!parse_hparams(ctx, model)) {
        gguf_free(ctx);
        if (meta_ctx) ggml_free(meta_ctx);
        return false;
    }
    
    if (!create_tensors(ctx, model)) {
        gguf_free(ctx);
        if (meta_ctx) ggml_free(meta_ctx);
        return false;
    }
    
    if (!load_tensor_data(path, ctx, model)) {
        free_model(model);
        gguf_free(ctx);
        if (meta_ctx) ggml_free(meta_ctx);
        return false;
    }
    
    gguf_free(ctx);
    if (meta_ctx) ggml_free(meta_ctx);
    
    return true;
}

bool GGUFLoader::parse_hparams(struct gguf_context * ctx, audio_encoder_model & model) {
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
    
    auto & hp = model.hparams;
    hp.n_encoder_layers = get_u32("audio.encoder_layers", 18);
    hp.d_model = get_u32("audio.d_model", 896);
    hp.n_attention_heads = get_u32("audio.attention_heads", 14);
    hp.ffn_dim = get_u32("audio.ffn_dim", 3584);
    hp.conv_channels = get_u32("audio.conv_channels", 480);
    hp.conv_out_dim = get_u32("audio.conv_out_dim", 896);
    hp.n_mel_bins = get_u32("audio.num_mel_bins", 128);
    hp.n_window_infer = get_u32("audio.n_window_infer", 800);
    hp.layer_norm_eps = get_f32("audio.layer_norm_eps", 1e-5f);
    
    auto & thp = model.text_hparams;
    thp.hidden_size = get_u32("text.hidden_size", 1024);
    thp.n_decoder_layers = get_u32("text.decoder_layers", 28);
    thp.n_attention_heads = get_u32("text.attention_heads", 16);
    thp.n_key_value_heads = get_u32("text.num_key_value_heads", 8);
    thp.intermediate_size = get_u32("text.intermediate_size", 3072);
    thp.rms_norm_eps = get_f32("text.rms_norm_eps", 1e-6f);
    
    return true;
}

bool GGUFLoader::create_tensors(struct gguf_context * ctx, audio_encoder_model & model) {
    const int64_t n_tensors = gguf_get_n_tensors(ctx);
    
    const size_t ctx_size = n_tensors * ggml_tensor_overhead();
    struct ggml_init_params params = {
        /*.mem_size   =*/ ctx_size,
        /*.mem_buffer =*/ nullptr,
        /*.no_alloc   =*/ true,
    };
    
    model.ctx = ggml_init(params);
    if (!model.ctx) {
        error_msg_ = "Failed to create GGML context";
        return false;
    }
    
    model.layers.resize(model.hparams.n_encoder_layers);
    
    for (int64_t i = 0; i < n_tensors; ++i) {
        const char * name = gguf_get_tensor_name(ctx, i);
        enum ggml_type type = gguf_get_tensor_type(ctx, i);
        
        int64_t ne[GGML_MAX_DIMS] = {1, 1, 1, 1};
        int n_dims = 0;
        
        size_t offset = gguf_get_tensor_offset(ctx, i);
        size_t size = gguf_get_tensor_size(ctx, i);
        
        (void)offset;
        
        size_t type_size = ggml_type_size(type);
        size_t blck_size = ggml_blck_size(type);
        
        int64_t total_elements = 1;
        size_t row_size = size;
        
        if (type_size > 0 && blck_size > 0) {
            total_elements = (size * blck_size) / type_size;
        }
        
        if (strstr(name, "encoder.conv1.weight")) {
            ne[0] = 3; ne[1] = 3; ne[2] = 1; ne[3] = model.hparams.conv_channels;
            n_dims = 4;
        } else if (strstr(name, "encoder.conv2.weight") || strstr(name, "encoder.conv3.weight")) {
            ne[0] = 3; ne[1] = 3; ne[2] = model.hparams.conv_channels; ne[3] = model.hparams.conv_channels;
            n_dims = 4;
        } else if ((strstr(name, "encoder.conv1.bias") || strstr(name, "encoder.conv2.bias") || 
                    strstr(name, "encoder.conv3.bias"))) {
            ne[0] = model.hparams.conv_channels;
            n_dims = 1;
        } else if (strstr(name, "encoder.conv_out.weight")) {
            ne[0] = model.hparams.conv_channels * 16;
            ne[1] = model.hparams.d_model;
            n_dims = 2;
        } else if (strstr(name, "attn_q.weight") || strstr(name, "attn_k.weight") || 
                   strstr(name, "attn_v.weight") || strstr(name, "attn_out.weight")) {
            ne[0] = model.hparams.d_model;
            ne[1] = model.hparams.d_model;
            n_dims = 2;
        } else if (strstr(name, "attn_q.bias") || strstr(name, "attn_k.bias") || 
                   strstr(name, "attn_v.bias") || strstr(name, "attn_out.bias") ||
                   strstr(name, "attn_norm.weight") || strstr(name, "attn_norm.bias")) {
            ne[0] = model.hparams.d_model;
            n_dims = 1;
        } else if (strstr(name, "ffn_up.weight")) {
            ne[0] = model.hparams.d_model;
            ne[1] = model.hparams.ffn_dim;
            n_dims = 2;
        } else if (strstr(name, "ffn_down.weight")) {
            ne[0] = model.hparams.ffn_dim;
            ne[1] = model.hparams.d_model;
            n_dims = 2;
        } else if (strstr(name, "ffn_up.bias")) {
            ne[0] = model.hparams.ffn_dim;
            n_dims = 1;
        } else if (strstr(name, "ffn_down.bias") || strstr(name, "ffn_norm.weight") || 
                   strstr(name, "ffn_norm.bias")) {
            ne[0] = model.hparams.d_model;
            n_dims = 1;
        } else if (strstr(name, "ln_post.weight") || strstr(name, "ln_post.bias")) {
            ne[0] = model.hparams.d_model;
            n_dims = 1;
        } else if (strstr(name, "encoder.proj1.weight")) {
            ne[0] = model.hparams.d_model;
            ne[1] = model.hparams.d_model;
            n_dims = 2;
        } else if (strstr(name, "encoder.proj1.bias")) {
            ne[0] = model.hparams.d_model;
            n_dims = 1;
        } else if (strstr(name, "encoder.proj2.weight")) {
            ne[0] = model.hparams.d_model;
            ne[1] = model.text_hparams.hidden_size;
            n_dims = 2;
        } else if (strstr(name, "encoder.proj2.bias")) {
            ne[0] = model.text_hparams.hidden_size;
            n_dims = 1;
        } else {
            int64_t remaining = total_elements;
            ne[0] = remaining;
            n_dims = 1;
        }
        
        struct ggml_tensor * tensor = ggml_new_tensor(model.ctx, type, n_dims, ne);
        if (!tensor) {
            error_msg_ = "Failed to create tensor: " + std::string(name);
            return false;
        }
        ggml_set_name(tensor, name);
        model.tensors[name] = tensor;
        
        if (strstr(name, "encoder.conv1.weight")) {
            model.conv2d1_w = tensor;
        } else if (strstr(name, "encoder.conv1.bias")) {
            model.conv2d1_b = tensor;
        } else if (strstr(name, "encoder.conv2.weight")) {
            model.conv2d2_w = tensor;
        } else if (strstr(name, "encoder.conv2.bias")) {
            model.conv2d2_b = tensor;
        } else if (strstr(name, "encoder.conv3.weight")) {
            model.conv2d3_w = tensor;
        } else if (strstr(name, "encoder.conv3.bias")) {
            model.conv2d3_b = tensor;
        } else if (strstr(name, "encoder.conv_out.weight")) {
            model.conv_out_w = tensor;
        } else if (strstr(name, "encoder.ln_post.weight")) {
            model.ln_post_w = tensor;
        } else if (strstr(name, "encoder.ln_post.bias")) {
            model.ln_post_b = tensor;
        } else if (strstr(name, "encoder.proj1.weight")) {
            model.proj1_w = tensor;
        } else if (strstr(name, "encoder.proj1.bias")) {
            model.proj1_b = tensor;
        } else if (strstr(name, "encoder.proj2.weight")) {
            model.proj2_w = tensor;
        } else if (strstr(name, "encoder.proj2.bias")) {
            model.proj2_b = tensor;
        } else if (strstr(name, "audio.encoder.blk.")) {
            int layer_idx = -1;
            if (sscanf(name, "audio.encoder.blk.%d.", &layer_idx) == 1 && 
                layer_idx >= 0 && layer_idx < model.hparams.n_encoder_layers) {
                auto & layer = model.layers[layer_idx];
                
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
        }
    }
    
    return true;
}

bool GGUFLoader::load_tensor_data(const std::string & path, struct gguf_context * ctx, 
                                   audio_encoder_model & model) {
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
    
    void * mmap_addr = mmap(nullptr, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    
    if (mmap_addr == MAP_FAILED) {
        error_msg_ = "Failed to mmap file: " + path;
        return false;
    }
    
    model.mmap_addr = mmap_addr;
    model.mmap_size = st.st_size;
    
    const size_t data_offset = gguf_get_data_offset(ctx);
    const size_t total_size = st.st_size - data_offset;
    uint8_t * data_base = (uint8_t *)mmap_addr + data_offset;
    
    // Find largest tensor for max_tensor_size hint
    const int64_t n_tensors = gguf_get_n_tensors(ctx);
    size_t max_tensor_size = 0;
    for (int64_t i = 0; i < n_tensors; ++i) {
        size_t sz = gguf_get_tensor_size(ctx, i);
        if (sz > max_tensor_size) max_tensor_size = sz;
    }

    // Try GPU device buffer (zero-copy on Apple Silicon unified memory)
    ggml_backend_dev_t gpu_dev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU);
    if (gpu_dev) {
        model.buffer = ggml_backend_dev_buffer_from_host_ptr(gpu_dev, data_base, total_size, max_tensor_size);
    }
    if (!model.buffer) {
        model.buffer = ggml_backend_cpu_buffer_from_ptr(data_base, total_size);
    }
    if (!model.buffer) {
        error_msg_ = "Failed to create buffer from mmap";
        munmap(mmap_addr, st.st_size);
        model.mmap_addr = nullptr;
        model.mmap_size = 0;
        return false;
    }
    
    for (int64_t i = 0; i < n_tensors; ++i) {
        const char * name = gguf_get_tensor_name(ctx, i);
        size_t offset = gguf_get_tensor_offset(ctx, i);
        
        auto it = model.tensors.find(name);
        if (it == model.tensors.end()) continue;
        
        struct ggml_tensor * tensor = it->second;
        tensor->buffer = model.buffer;
        tensor->data = data_base + offset;
    }
    
    return true;
}

void free_model(audio_encoder_model & model) {
    if (model.buffer) {
        ggml_backend_buffer_free(model.buffer);
        model.buffer = nullptr;
    }
    if (model.ctx) {
        ggml_free(model.ctx);
        model.ctx = nullptr;
    }
    if (model.mmap_addr) {
        munmap(model.mmap_addr, model.mmap_size);
        model.mmap_addr = nullptr;
        model.mmap_size = 0;
    }
    model.tensors.clear();
    model.layers.clear();
}

} // namespace qwen3_asr
