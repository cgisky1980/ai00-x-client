#pragma once

#include "ggml.h"
#include "ggml-backend.h"
#include "gguf.h"

#include <string>
#include <map>
#include <vector>
#include <memory>

namespace qwen3_asr {

struct text_decoder_config {
    int32_t vocab_size = 151936;
    int32_t hidden_size = 1024;
    int32_t n_decoder_layers = 28;
    int32_t n_attention_heads = 32;
    int32_t n_key_value_heads = 16;
    int32_t intermediate_size = 3072;
    int32_t head_dim = 64;
    float rms_norm_eps = 1e-6f;
    float rope_theta = 1000000.0f;
    
    int32_t pad_token_id = 151643;
    int32_t eos_token_id = 151645;
    int32_t audio_start_token_id = 151669;
    int32_t audio_end_token_id = 151670;
    int32_t audio_pad_token_id = 151676;
};

struct decoder_layer {
    struct ggml_tensor * attn_norm = nullptr;
    
    struct ggml_tensor * attn_q = nullptr;
    struct ggml_tensor * attn_k = nullptr;
    struct ggml_tensor * attn_v = nullptr;
    struct ggml_tensor * attn_output = nullptr;
    struct ggml_tensor * attn_q_norm = nullptr;
    struct ggml_tensor * attn_k_norm = nullptr;
    
    struct ggml_tensor * ffn_norm = nullptr;
    
    struct ggml_tensor * ffn_gate = nullptr;
    struct ggml_tensor * ffn_up = nullptr;
    struct ggml_tensor * ffn_down = nullptr;
};

// Text decoder model weights
struct text_decoder_model {
    text_decoder_config config;
    
    // Token embedding
    struct ggml_tensor * token_embd = nullptr;  // [vocab_size, hidden_size]
    
    // Transformer layers
    std::vector<decoder_layer> layers;
    
    // Final RMSNorm
    struct ggml_tensor * output_norm = nullptr; // [hidden_size]
    
    // LM head
    struct ggml_tensor * output = nullptr;      // [hidden_size, vocab_size]
    
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

// KV cache for autoregressive generation
struct kv_cache {
    std::vector<struct ggml_tensor *> k_cache;  // Per-layer K cache
    std::vector<struct ggml_tensor *> v_cache;  // Per-layer V cache
    
    struct ggml_context * ctx = nullptr;
    ggml_backend_buffer_t buffer = nullptr;
    
    int32_t n_ctx = 0;      // Maximum context length
    int32_t n_used = 0;     // Current number of cached tokens
    int32_t head_dim = 64;
    int32_t n_kv_heads = 8;
    int32_t n_layers = 28;
};

// Text decoder state
struct text_decoder_state {
    ggml_backend_t backend_cpu = nullptr;
    ggml_backend_t backend_gpu = nullptr;
    ggml_backend_sched_t sched = nullptr;
    
    std::vector<uint8_t> compute_meta;
    
    kv_cache cache;
};

// Text decoder class
class TextDecoder {
public:
    TextDecoder();
    ~TextDecoder();
    
    // Load model from GGUF file
    bool load_model(const std::string & model_path);
    
    // Initialize KV cache for given context length
    bool init_kv_cache(int32_t n_ctx);
    
    // Clear KV cache (for new sequence)
    void clear_kv_cache();
    
    // Forward pass: compute logits for input tokens
    // tokens: input token IDs [n_tokens]
    // n_past: number of tokens already in KV cache
    // output: logits [n_tokens, vocab_size]
    bool forward(const int32_t * tokens, int32_t n_tokens, int32_t n_past,
                 std::vector<float> & output);
    
    // Forward pass with audio embedding injection
    // tokens: input token IDs [n_tokens]
    // audio_embd: audio embeddings [n_audio, hidden_size]
    // audio_start_pos: position in token sequence where audio starts
    // n_past: number of tokens already in KV cache
    // output: logits [n_tokens, vocab_size]
    bool forward_with_audio(const int32_t * tokens, int32_t n_tokens,
                            const float * audio_embd, int32_t n_audio,
                            int32_t audio_start_pos, int32_t n_past,
                            std::vector<float> & output);
    
    const text_decoder_config & get_config() const { return model_.config; }
    
    const std::string & get_error() const { return error_msg_; }
    
    std::string decode_token(int32_t token_id) const;
    
    std::string decode_tokens(const std::vector<int32_t> & tokens) const;
    
    bool forward_debug(const int32_t * tokens, int32_t n_tokens, int32_t n_past,
                       std::vector<float> & output,
                       std::map<std::string, std::vector<float>> & debug_tensors);
    
private:
    // Build computation graph for forward pass
    struct ggml_cgraph * build_graph(const int32_t * tokens, int32_t n_tokens,
                                     int32_t n_past,
                                     const float * audio_embd = nullptr,
                                     int32_t n_audio = 0,
                                     int32_t audio_start_pos = 0);
    
    // Parse hyperparameters from GGUF
    bool parse_config(struct gguf_context * ctx);
    
    // Create tensor structures
    bool create_tensors(struct gguf_context * ctx);
    
    // Load tensor data from file
    bool load_tensor_data(const std::string & path, struct gguf_context * ctx);
    
    bool load_vocab(struct gguf_context * ctx);
    
    text_decoder_model model_;
    text_decoder_state state_;
    std::string error_msg_;
    std::vector<std::string> vocab_;
    // float temperature_ = 1.0f;
};

// Free model resources
void free_decoder_model(text_decoder_model & model);

// Free KV cache resources
void free_kv_cache(kv_cache & cache);

} // namespace qwen3_asr
