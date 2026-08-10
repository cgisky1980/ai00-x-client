#ifndef MEL_SPECTROGRAM_H
#define MEL_SPECTROGRAM_H

#include <cstdint>
#include <vector>
#include <string>

// Constants matching Qwen3-ASR / Whisper preprocessing
constexpr int QWEN_SAMPLE_RATE = 16000;
constexpr int QWEN_N_FFT = 400;
constexpr int QWEN_HOP_LENGTH = 160;
constexpr int QWEN_N_MELS = 128;
constexpr int QWEN_CHUNK_SIZE = 30;  // seconds
constexpr int QWEN_N_SAMPLES = QWEN_SAMPLE_RATE * QWEN_CHUNK_SIZE;  // 480000
constexpr int QWEN_N_FFT_BINS = 1 + (QWEN_N_FFT / 2);  // 201 positive frequency bins

// Mel spectrogram output structure
struct MelSpectrogram {
    int32_t n_mel;      // Number of mel bins (128)
    int32_t n_len;      // Number of time frames
    int32_t n_len_org;  // Original length before padding
    std::vector<float> data;  // [n_mel x n_len] in mel-major order
};

// Mel filterbank structure
struct MelFilters {
    int32_t n_mel;  // 128
    int32_t n_fft;  // 201
    std::vector<float> data;  // [n_mel x n_fft]
};

// Load audio from WAV file (16-bit PCM, mono, 16kHz)
// Returns samples normalized to [-1, 1]
bool load_wav(const std::string& path, std::vector<float>& samples, int& sample_rate);

// Load mel filterbank from numpy .npy file
// Expected shape: (201, 128) - will be transposed to (128, 201)
bool load_mel_filters_npy(const std::string& path, MelFilters& filters);

// Generate mel filterbank programmatically
// Uses HTK mel scale: mel = 2595 * log10(1 + f/700)
void generate_mel_filters(MelFilters& filters, int n_mels = QWEN_N_MELS, 
                          int n_fft = QWEN_N_FFT, int sample_rate = QWEN_SAMPLE_RATE);

// Compute log mel spectrogram
// Matches HuggingFace WhisperFeatureExtractor output
// Parameters:
//   samples: Input audio samples (normalized to [-1, 1])
//   n_samples: Number of samples
//   filters: Mel filterbank
//   mel: Output mel spectrogram
//   n_threads: Number of threads for parallel processing (default 1)
bool log_mel_spectrogram(const float* samples, int n_samples,
                         const MelFilters& filters, MelSpectrogram& mel,
                         int n_threads = 1);

// Save mel spectrogram to numpy .npy file
bool save_mel_npy(const std::string& path, const MelSpectrogram& mel);

// Load mel spectrogram from numpy .npy file (for comparison)
bool load_mel_npy(const std::string& path, MelSpectrogram& mel);

// Compare two mel spectrograms
// Returns max absolute difference
float compare_mel(const MelSpectrogram& a, const MelSpectrogram& b);

#endif // MEL_SPECTROGRAM_H
