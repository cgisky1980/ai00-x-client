#include "audio_injection.h"

#include <cstring>
#include <algorithm>

namespace qwen3_asr {

std::vector<int32_t> find_audio_positions(
    const int32_t * input_ids,
    int32_t n_tokens,
    int32_t audio_pad_token_id) {
    
    std::vector<int32_t> positions;
    positions.reserve(n_tokens);
    
    for (int32_t i = 0; i < n_tokens; ++i) {
        if (input_ids[i] == audio_pad_token_id) {
            positions.push_back(i);
        }
    }
    
    return positions;
}

void embed_tokens(
    const int32_t * input_ids,
    int32_t n_tokens,
    const float * token_embd,
    int32_t vocab_size,
    int32_t hidden_size,
    float * output) {
    
    for (int32_t i = 0; i < n_tokens; ++i) {
        int32_t token_id = input_ids[i];
        
        if (token_id < 0 || token_id >= vocab_size) {
            std::memset(output + i * hidden_size, 0, hidden_size * sizeof(float));
            continue;
        }
        
        const float * src = token_embd + token_id * hidden_size;
        float * dst = output + i * hidden_size;
        std::memcpy(dst, src, hidden_size * sizeof(float));
    }
}

bool inject_audio_embeddings(
    float * token_embeddings,
    int32_t n_tokens,
    int32_t hidden_size,
    const float * audio_features,
    int32_t n_audio_frames,
    const std::vector<int32_t> & audio_positions) {
    
    if (static_cast<int32_t>(audio_positions.size()) != n_audio_frames) {
        return false;
    }
    
    for (int32_t i = 0; i < n_audio_frames; ++i) {
        int32_t pos = audio_positions[i];
        
        if (pos < 0 || pos >= n_tokens) {
            return false;
        }
        
        const float * src = audio_features + i * hidden_size;
        float * dst = token_embeddings + pos * hidden_size;
        std::memcpy(dst, src, hidden_size * sizeof(float));
    }
    
    return true;
}

injection_result inject_audio(
    const int32_t * input_ids,
    int32_t n_tokens,
    const float * audio_features,
    int32_t n_audio_frames,
    const audio_injection_context & ctx) {
    
    injection_result result;
    result.seq_len = n_tokens;
    result.hidden_size = ctx.hidden_size;
    
    if (!ctx.token_embd) {
        result.error_msg = "Token embedding weights not provided";
        return result;
    }
    
    if (n_tokens <= 0) {
        result.error_msg = "Invalid token count";
        return result;
    }
    
    std::vector<int32_t> audio_positions = find_audio_positions(
        input_ids, n_tokens, ctx.tokens.audio_pad_token_id);
    
    if (audio_features && n_audio_frames > 0) {
        if (static_cast<int32_t>(audio_positions.size()) != n_audio_frames) {
            result.error_msg = "Mismatch: " + 
                std::to_string(audio_positions.size()) + " audio_pad tokens but " +
                std::to_string(n_audio_frames) + " audio frames";
            return result;
        }
    }
    
    result.embeddings.resize(n_tokens * ctx.hidden_size);
    
    embed_tokens(input_ids, n_tokens, ctx.token_embd, 
                 ctx.vocab_size, ctx.hidden_size, result.embeddings.data());
    
    if (audio_features && n_audio_frames > 0 && !audio_positions.empty()) {
        if (!inject_audio_embeddings(result.embeddings.data(), n_tokens, ctx.hidden_size,
                                     audio_features, n_audio_frames, audio_positions)) {
            result.error_msg = "Failed to inject audio embeddings";
            return result;
        }
    }
    
    result.success = true;
    return result;
}

bool validate_audio_injection(
    const int32_t * input_ids,
    int32_t n_tokens,
    int32_t n_audio_frames,
    int32_t audio_pad_token_id,
    std::string & error_msg) {
    
    int32_t pad_count = count_audio_pad_tokens(input_ids, n_tokens, audio_pad_token_id);
    
    if (pad_count != n_audio_frames) {
        error_msg = "Expected " + std::to_string(n_audio_frames) + 
                    " audio_pad tokens but found " + std::to_string(pad_count);
        return false;
    }
    
    return true;
}

int32_t find_audio_start_position(
    const int32_t * input_ids,
    int32_t n_tokens,
    int32_t audio_pad_token_id) {
    
    for (int32_t i = 0; i < n_tokens; ++i) {
        if (input_ids[i] == audio_pad_token_id) {
            return i;
        }
    }
    
    return -1;
}

int32_t count_audio_pad_tokens(
    const int32_t * input_ids,
    int32_t n_tokens,
    int32_t audio_pad_token_id) {
    
    int32_t count = 0;
    for (int32_t i = 0; i < n_tokens; ++i) {
        if (input_ids[i] == audio_pad_token_id) {
            ++count;
        }
    }
    
    return count;
}

}
