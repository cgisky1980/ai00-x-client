#pragma once

#include "gguf_loader.h"

#include <vector>

namespace qwen3_asr {

struct audio_encoder_state {
    ggml_backend_t backend_cpu = nullptr;
    ggml_backend_t backend_gpu = nullptr;
    ggml_backend_sched_t sched = nullptr;
    
    std::vector<uint8_t> compute_meta;
    
    struct ggml_tensor * embd_conv = nullptr;
    struct ggml_tensor * embd_enc = nullptr;
};

class AudioEncoder {
public:
    AudioEncoder();
    ~AudioEncoder();
    
    bool load_model(const std::string & model_path);
    
    bool encode(const float * mel_data, int n_mel, int n_frames, 
                std::vector<float> & output);
    
    bool encode_conv_only(const float * mel_data, int n_mel, int n_frames,
                          std::vector<float> & output);
    
    // Encode without chunking (for testing/debugging)
    bool encode_no_chunk(const float * mel_data, int n_mel, int n_frames,
                         std::vector<float> & output);
    
    const audio_encoder_hparams & get_hparams() const { return model_.hparams; }
    const text_decoder_hparams & get_text_hparams() const { return model_.text_hparams; }
    
    const std::string & get_error() const { return error_msg_; }
    
private:
    struct ggml_cgraph * build_graph_conv(int n_frames);
    struct ggml_cgraph * build_graph_encoder(int n_ctx);
    
    bool compute_graph(struct ggml_cgraph * graph);
    
    audio_encoder_model model_;
    audio_encoder_state state_;
    std::string error_msg_;
    
    int n_threads_ = 4;
};

} // namespace qwen3_asr
