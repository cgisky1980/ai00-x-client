cmake_minimum_required(VERSION 3.14)
project(qwen3_fa VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -w")
    set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -O3")
endif()

find_package(Threads REQUIRED)

# GGML library (shared, already built by inference/build.rs)
# qwen3-fa-cpp is at src/crates/inference/qwen3-fa-cpp/, repo root is 4 levels up.
set(GGML_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../llama.cpp/ggml")
set(GGML_BUILD_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../.llama-build")

# We link against the GGML shared libs (ggml-base, ggml, ggml-cuda, ...) that
# were already built by the parent inference/build.rs. We only need the headers
# and the .lib import libraries.

# Mel spectrogram (pure C++, no GGML)
add_library(mel_spectrogram STATIC
    mel_spectrogram.cpp
)
target_include_directories(mel_spectrogram PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(mel_spectrogram PRIVATE Threads::Threads)

# ForcedAligner shared library (DLL)
add_library(qwen3_fa SHARED
    forced_aligner.cpp
    fa_c_api.cpp
)
# Define FA_EXPORTS so fa_c_api.h exports symbols with __declspec(dllexport)
target_compile_definitions(qwen3_fa PRIVATE FA_EXPORTS)
target_include_directories(qwen3_fa PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${GGML_DIR}/include
)
target_link_directories(qwen3_fa PUBLIC
    ${GGML_BUILD_DIR}/ggml/src/Release
    ${GGML_BUILD_DIR}/ggml/src
    ${GGML_BUILD_DIR}/bin/Release
    ${GGML_BUILD_DIR}/bin
)
target_link_libraries(qwen3_fa PUBLIC
    mel_spectrogram
    ggml-base
    ggml
    Threads::Threads
)

# On Windows, output to a known location
set_target_properties(qwen3_fa PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/Release"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/Release"
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/Release"
)
