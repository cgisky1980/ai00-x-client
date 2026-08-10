#pragma once

#include <vector>
#include <cstdint>
#include <string>

namespace qwen3_asr {

// Token IDs for audio injection
struct audio_token_ids {
    int32_t audio_start_token_id = 151669;  // <|audio_start|>
    int32_t audio_end_token_id = 151670;    // <|audio_end|>
    int32_t audio_pad_token_id = 151676;    // <|audio_pad|>
};

// Result of audio injection
struct injection_result {
    std::vector<float> embeddings;  // Combined embeddings [seq_len, hidden_size]
    int32_t seq_len = 0;
    int32_t hidden_size = 0;
    bool success = false;
    std::string error_msg;
};

// Audio injection context
struct audio_injection_context {
    // Token embedding weights [vocab_size, hidden_size]
    const float * token_embd = nullptr;
    int32_t vocab_size = 0;
    int32_t hidden_size = 0;
    
    // Token IDs
    audio_token_ids tokens;
};

// Find positions of audio_pad tokens in input_ids
// Returns vector of positions where input_ids[i] == audio_pad_token_id
std::vector<int32_t> find_audio_positions(
    const int32_t * input_ids,
    int32_t n_tokens,
    int32_t audio_pad_token_id);

// Perform token embedding lookup
// input_ids: [n_tokens]
// token_embd: [vocab_size, hidden_size] (row-major)
// output: [n_tokens, hidden_size]
void embed_tokens(
    const int32_t * input_ids,
    int32_t n_tokens,
    const float * token_embd,
    int32_t vocab_size,
    int32_t hidden_size,
    float * output);

// Inject audio embeddings at placeholder positions (masked_scatter equivalent)
// This replaces token embeddings at audio_pad positions with audio features
//
// token_embeddings: [n_tokens, hidden_size] - will be modified in place
// audio_features: [n_audio_frames, hidden_size]
// audio_positions: positions where audio should be injected
//
// Returns true if successful, false if mismatch between positions and audio frames
bool inject_audio_embeddings(
    float * token_embeddings,
    int32_t n_tokens,
    int32_t hidden_size,
    const float * audio_features,
    int32_t n_audio_frames,
    const std::vector<int32_t> & audio_positions);

// High-level function: combine token embedding and audio injection
// 
// input_ids: [n_tokens] - token IDs including audio_pad placeholders
// audio_features: [n_audio_frames, hidden_size] - audio encoder output
// ctx: injection context with token embeddings and config
//
// Returns combined embeddings ready for decoder
injection_result inject_audio(
    const int32_t * input_ids,
    int32_t n_tokens,
    const float * audio_features,
    int32_t n_audio_frames,
    const audio_injection_context & ctx);

// Validate that audio injection is possible
// Checks that number of audio_pad tokens matches n_audio_frames
bool validate_audio_injection(
    const int32_t * input_ids,
    int32_t n_tokens,
    int32_t n_audio_frames,
    int32_t audio_pad_token_id,
    std::string & error_msg);

// Find the start position of audio in the sequence
// Returns the index of the first audio_pad token, or -1 if not found
int32_t find_audio_start_position(
    const int32_t * input_ids,
    int32_t n_tokens,
    int32_t audio_pad_token_id);

// Count audio_pad tokens in sequence
int32_t count_audio_pad_tokens(
    const int32_t * input_ids,
    int32_t n_tokens,
    int32_t audio_pad_token_id);

} // namespace qwen3_asr
