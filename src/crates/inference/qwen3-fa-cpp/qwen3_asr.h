#pragma once

#include "mel_spectrogram.h"
#include "audio_encoder.h"
#include "text_decoder.h"
#include "audio_injection.h"

#include <string>
#include <vector>
#include <functional>

namespace qwen3_asr {

// Transcription parameters
struct transcribe_params {
    // Maximum number of tokens to generate
    int32_t max_tokens = 1024;
    
    // Language code (optional, for prompting)
    std::string language = "";
    
    // Number of threads for mel computation
    int32_t n_threads = 4;
    
    // Print progress during transcription
    bool print_progress = false;
    
    // Print timing information
    bool print_timing = true;
};

// Transcription result
struct transcribe_result {
    std::string language;
    std::string text;
    std::vector<int32_t> tokens;
    bool success = false;
    std::string error_msg;
    
    // Timing info (in milliseconds)
    int64_t t_load_ms = 0;
    int64_t t_mel_ms = 0;
    int64_t t_encode_ms = 0;
    int64_t t_decode_ms = 0;
    int64_t t_total_ms = 0;
};

// Progress callback type
using progress_callback_t = std::function<void(int tokens_generated, int max_tokens)>;

// Main ASR class that orchestrates the full pipeline
class Qwen3ASR {
public:
    Qwen3ASR();
    ~Qwen3ASR();
    
    // Load model from GGUF file
    // Returns true on success, false on failure (check get_error())
    bool load_model(const std::string & model_path);
    
    // Transcribe audio file (WAV format, 16kHz mono)
    // Returns transcription result
    transcribe_result transcribe(const std::string & audio_path, 
                                  const transcribe_params & params = transcribe_params());
    
    // Transcribe raw audio samples
    // samples: audio samples normalized to [-1, 1]
    // n_samples: number of samples
    transcribe_result transcribe(const float * samples, int n_samples,
                                  const transcribe_params & params = transcribe_params());
    
    // Set progress callback
    void set_progress_callback(progress_callback_t callback);
    
    // Get error message
    const std::string & get_error() const { return error_msg_; }
    
    // Check if model is loaded
    bool is_loaded() const { return model_loaded_; }
    
    // Get model config
    const text_decoder_config & get_config() const { return decoder_.get_config(); }
    
private:
    // Internal transcription implementation
    transcribe_result transcribe_internal(const float * samples, int n_samples,
                                           const transcribe_params & params);
    
    // Build input token sequence for audio
    std::vector<int32_t> build_input_tokens(int32_t n_audio_frames, 
                                             const std::string & language);
    
    // Greedy decoding loop
    bool decode_greedy(const std::vector<int32_t> & input_tokens,
                       const std::vector<float> & audio_features,
                       int32_t n_audio_frames,
                       const transcribe_params & params,
                       std::vector<int32_t> & output_tokens);
    
    // Sample next token (greedy: argmax)
    int32_t sample_greedy(const float * logits, int32_t vocab_size);
    
    // Components
    AudioEncoder encoder_;
    TextDecoder decoder_;
    MelFilters mel_filters_;
    
    // State
    bool model_loaded_ = false;
    std::string error_msg_;
    progress_callback_t progress_callback_;
};

bool load_audio_file(const std::string & path, std::vector<float> & samples, int & sample_rate);

} // namespace qwen3_asr
