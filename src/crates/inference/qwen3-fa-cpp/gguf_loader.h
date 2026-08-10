#pragma once

#include "ggml.h"
#include "ggml-backend.h"
#include "gguf.h"

#include <string>
#include <map>
#include <vector>
#include <memory>

namespace qwen3_asr {

// Model hyperparameters for audio encoder
struct audio_encoder_hparams {
    int32_t n_encoder_layers = 18;
    int32_t d_model = 896;
    int32_t n_attention_heads = 14;
    int32_t ffn_dim = 3584;
    int32_t conv_channels = 480;
    int32_t conv_out_dim = 896;
    int32_t n_mel_bins = 128;
    int32_t n_window_infer = 800;
    float layer_norm_eps = 1e-5f;
};

// Text decoder hyperparameters (for output projection)
struct text_decoder_hparams {
    int32_t hidden_size = 1024;
    int32_t n_decoder_layers = 28;
    int32_t n_attention_heads = 16;
    int32_t n_key_value_heads = 8;
    int32_t intermediate_size = 3072;
    float rms_norm_eps = 1e-6f;
};

// Single encoder layer weights
struct encoder_layer {
    // Self-attention
    struct ggml_tensor * attn_q_w = nullptr;
    struct ggml_tensor * attn_q_b = nullptr;
    struct ggml_tensor * attn_k_w = nullptr;
    struct ggml_tensor * attn_k_b = nullptr;
    struct ggml_tensor * attn_v_w = nullptr;
    struct ggml_tensor * attn_v_b = nullptr;
    struct ggml_tensor * attn_out_w = nullptr;
    struct ggml_tensor * attn_out_b = nullptr;
    
    // Attention layer norm (pre-attention)
    struct ggml_tensor * attn_norm_w = nullptr;
    struct ggml_tensor * attn_norm_b = nullptr;
    
    // FFN
    struct ggml_tensor * ffn_up_w = nullptr;
    struct ggml_tensor * ffn_up_b = nullptr;
    struct ggml_tensor * ffn_down_w = nullptr;
    struct ggml_tensor * ffn_down_b = nullptr;
    
    // FFN layer norm (pre-FFN)
    struct ggml_tensor * ffn_norm_w = nullptr;
    struct ggml_tensor * ffn_norm_b = nullptr;
};

// Audio encoder model weights
struct audio_encoder_model {
    audio_encoder_hparams hparams;
    text_decoder_hparams text_hparams;
    
    // Conv2D front-end
    struct ggml_tensor * conv2d1_w = nullptr;
    struct ggml_tensor * conv2d1_b = nullptr;
    struct ggml_tensor * conv2d2_w = nullptr;
    struct ggml_tensor * conv2d2_b = nullptr;
    struct ggml_tensor * conv2d3_w = nullptr;
    struct ggml_tensor * conv2d3_b = nullptr;
    
    // Output projection (conv_out)
    struct ggml_tensor * conv_out_w = nullptr;
    
    struct ggml_tensor * ln_post_w = nullptr;
    struct ggml_tensor * ln_post_b = nullptr;
    struct ggml_tensor * proj1_w = nullptr;
    struct ggml_tensor * proj1_b = nullptr;
    struct ggml_tensor * proj2_w = nullptr;
    struct ggml_tensor * proj2_b = nullptr;
    
    // Transformer encoder layers
    std::vector<encoder_layer> layers;
    
    // GGML context for tensor metadata
    struct ggml_context * ctx = nullptr;
    
    // Backend buffer for weights
    ggml_backend_buffer_t buffer = nullptr;
    
    // mmap state — must outlive all tensors backed by this mapping
    void * mmap_addr = nullptr;
    size_t mmap_size = 0;
    
    // Tensor name to tensor mapping
    std::map<std::string, struct ggml_tensor *> tensors;
};

// GGUF model loader class
class GGUFLoader {
public:
    GGUFLoader();
    ~GGUFLoader();
    
    // Load model from GGUF file
    bool load(const std::string & path, audio_encoder_model & model);
    
    // Get error message if load failed
    const std::string & get_error() const { return error_msg_; }
    
private:
    // Parse hyperparameters from GGUF metadata
    bool parse_hparams(struct gguf_context * ctx, audio_encoder_model & model);
    
    // Create tensor structures
    bool create_tensors(struct gguf_context * ctx, audio_encoder_model & model);
    
    // Load tensor data from file
    bool load_tensor_data(const std::string & path, struct gguf_context * ctx, 
                          audio_encoder_model & model);
    
    std::string error_msg_;
};

// Free model resources
void free_model(audio_encoder_model & model);

} // namespace qwen3_asr
