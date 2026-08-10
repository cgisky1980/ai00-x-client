#include "ggml.h"
#include "gguf.h"
#include <cstdio>
#include <vector>
#include <string>
#include <cstring>
#include <algorithm>
#ifdef _OPENMP
#include <omp.h>
#endif


ggml_type ggml_parse_type(const std::string & str) {
    std::string s = str;
    std::transform(s.begin(), s.end(), s.begin(), ::toupper);
    if (s == "F32")    return GGML_TYPE_F32;
    if (s == "F16")    return GGML_TYPE_F16;
    if (s == "Q4_0")   return GGML_TYPE_Q4_0;
    if (s == "Q4_1")   return GGML_TYPE_Q4_1;
    if (s == "Q4_K" || s == "Q4_K_M" || s == "Q4_K_S") return GGML_TYPE_Q4_K;
    if (s == "Q5_0")   return GGML_TYPE_Q5_0;
    if (s == "Q5_1")   return GGML_TYPE_Q5_1;
    if (s == "Q5_K" || s == "Q5_K_M" || s == "Q5_K_S") return GGML_TYPE_Q5_K;
    if (s == "Q8_0")   return GGML_TYPE_Q8_0;
    return GGML_TYPE_COUNT;
}


// Helper to check alignment
bool is_aligned(struct ggml_tensor * tensor, ggml_type type) {
    // ggml_blck_size returns the required multiple for a given type
    // e.g., 32 for Q4_0, 256 for Q4_K
    int block_size = ggml_blck_size(type);
    return (tensor->ne[0] % block_size == 0);
}


bool should_quantize(const std::string & name, struct ggml_tensor * tensor, ggml_type type) {
    // 1. Skip by name (standard heuristic)
    if (name.find("bias") != std::string::npos || 
        name.find("norm") != std::string::npos ||
        name.find("token_embd") != std::string::npos ||
        name.find("ln_post") !=  std::string::npos) {
        return false;
    }

    // 2. Skip if not aligned (CRITICAL for Conv layers)
    if (!is_aligned(tensor, type)) {
        return false;
    }

    return true;
}


int main(int argc, char ** argv) {
    if (argc < 4) {
        fprintf(stderr, "Usage: %s input.gguf output.gguf type\n", argv[0]);
        return 1;
    }

    const char * fname_inp = argv[1];
    const char * fname_out = argv[2];
    ggml_type target_type  = ggml_parse_type(argv[3]);

    struct ggml_context * ctx_data = NULL;
    struct gguf_init_params params = { .no_alloc = false, .ctx = &ctx_data };
    struct gguf_context * ctx_inp = gguf_init_from_file(fname_inp, params);
    if (!ctx_inp) return 1;

    struct gguf_context * ctx_out = gguf_init_empty();
    gguf_set_kv(ctx_out, ctx_inp);

    int n_tensors = gguf_get_n_tensors(ctx_inp);
    struct ggml_init_params meta_params = {
        .mem_size   = ggml_tensor_overhead() * n_tensors + (2 * 1024 * 1024),
        .no_alloc   = true,
    };
    struct ggml_context * ctx_meta = ggml_init(meta_params);
    
    // Preparation for parallel results
    std::vector<struct ggml_tensor *> new_tensors(n_tensors);
    std::vector<void *> allocated_data(n_tensors, nullptr);

#ifdef _OPENMP
    printf("Starting quantization with %d threads...\n", omp_get_max_threads());
#else
    printf("Starting quantization (single-threaded)...\n");
#endif

    #pragma omp parallel for schedule(dynamic)
    for (int i = 0; i < n_tensors; ++i) {
        const char * name = gguf_get_tensor_name(ctx_inp, i);
        struct ggml_tensor * tensor = ggml_get_tensor(ctx_data, name);
        int64_t n_elements = ggml_nelements(tensor);

        if (should_quantize(name, tensor, target_type) && (tensor->type == GGML_TYPE_F32 || tensor->type == GGML_TYPE_F16)) {
            // Bridge to F32
            std::vector<float> f32_buf(n_elements);
            const float * src_ptr = nullptr;
            if (tensor->type == GGML_TYPE_F16) {
                ggml_fp16_to_fp32_row((const ggml_fp16_t *)tensor->data, f32_buf.data(), n_elements);
                src_ptr = f32_buf.data();
            } else {
                src_ptr = (const float *)tensor->data;
            }

            size_t size_new = ggml_row_size(target_type, n_elements);
            void * data_new = malloc(size_new);
            allocated_data[i] = data_new;

            ggml_quantize_chunk(target_type, src_ptr, data_new, 0, n_elements / tensor->ne[0], tensor->ne[0], nullptr);

            #pragma omp critical
            {
                printf("[%3d/%d] Quantizing %-40s to %s\n", i+1, n_tensors, name, ggml_type_name(target_type));
                struct ggml_tensor * q_t = ggml_new_tensor(ctx_meta, target_type, ggml_n_dims(tensor), tensor->ne);
                ggml_set_name(q_t, name);
                q_t->data = data_new;
                new_tensors[i] = q_t;
            }
        }
        else if (tensor->type == GGML_TYPE_F16) {
            // --- SMART FALLBACK SYSTEM ---
            ggml_type fallback_type = GGML_TYPE_F32; // Default fallback

            // Try to use Q8_0 if it's aligned (better than F16 or F32)
            if (is_aligned(tensor, GGML_TYPE_Q8_0)) {
                fallback_type = GGML_TYPE_Q8_0;
            }

            // Prepare F32 source for the quantizer
            std::vector<float> f32_buf(n_elements);
            const float * src_ptr = nullptr;
            if (tensor->type == GGML_TYPE_F16) {
                ggml_fp16_to_fp32_row((const ggml_fp16_t *)tensor->data, f32_buf.data(), n_elements);
                src_ptr = f32_buf.data();
            } else {
                src_ptr = (const float *)tensor->data;
            }

            size_t size_new = ggml_row_size(fallback_type, n_elements);
            void * data_new = malloc(size_new);
            allocated_data[i] = data_new;

            if (fallback_type == GGML_TYPE_Q8_0) {
                #pragma omp critical
                printf("[%3d/%d] Fallback   %-40s to Q8_0\n", i+1, n_tensors, name);
                ggml_quantize_chunk(fallback_type, src_ptr, data_new, 0, n_elements / tensor->ne[0], tensor->ne[0], nullptr);
            } else {
                #pragma omp critical
                printf("[%3d/%d] Fallback   %-40s to F32\n", i+1, n_tensors, name);
                memcpy(data_new, src_ptr, size_new);
            }

            #pragma omp critical
            {
                struct ggml_tensor * f_t = ggml_new_tensor(ctx_meta, fallback_type, ggml_n_dims(tensor), tensor->ne);
                ggml_set_name(f_t, name);
                f_t->data = data_new;
                new_tensors[i] = f_t;
            }
        }
        else {
            new_tensors[i] = tensor; // Keep existing (F32 or already quantized)
        }
    }

    // Serial step to add to GGUF
    for (int i = 0; i < n_tensors; ++i) {
        gguf_add_tensor(ctx_out, new_tensors[i]);
    }

    gguf_write_to_file(ctx_out, fname_out, false);

    // Cleanup
    for (void * ptr : allocated_data) if(ptr) free(ptr);
    ggml_free(ctx_meta);
    ggml_free(ctx_data);
    gguf_free(ctx_inp);
    gguf_free(ctx_out);
    
    return 0;
}
