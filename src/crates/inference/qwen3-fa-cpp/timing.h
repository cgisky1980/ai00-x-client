#pragma once

#include <chrono>
#include <cstdio>
#include <map>
#include <string>

namespace qwen3_asr {

#ifdef QWEN3_ASR_TIMING

class TimingProfiler {
public:
    static TimingProfiler & instance() {
        static TimingProfiler profiler;
        return profiler;
    }

    void record(const std::string & name, int64_t duration_us) {
        auto & entry = timings_[name];
        entry.first += duration_us;
        entry.second += 1;
    }

    void reset() {
        timings_.clear();
    }

    void print_report() const {
        fprintf(stderr, "\n");
        fprintf(stderr, "================================================================================\n");
        fprintf(stderr, "                         TIMING PROFILE REPORT\n");
        fprintf(stderr, "================================================================================\n");
        fprintf(stderr, "%-45s %12s %8s %12s\n", "Section", "Total (ms)", "Calls", "Avg (ms)");
        fprintf(stderr, "--------------------------------------------------------------------------------\n");

        for (const auto & entry : timings_) {
            double total_ms = entry.second.first / 1000.0;
            int64_t calls = entry.second.second;
            double avg_ms = calls > 0 ? total_ms / calls : 0.0;
            fprintf(stderr, "%-45s %12.2f %8lld %12.2f\n",
                    entry.first.c_str(), total_ms, (long long)calls, avg_ms);
        }

        fprintf(stderr, "================================================================================\n");
    }

private:
    TimingProfiler() = default;
    std::map<std::string, std::pair<int64_t, int64_t>> timings_; // total_us, count
};

class ScopedTimer {
public:
    ScopedTimer(const std::string & name)
        : name_(name)
        , start_(std::chrono::high_resolution_clock::now()) {}

    ~ScopedTimer() {
        auto end = std::chrono::high_resolution_clock::now();
        auto duration_us = std::chrono::duration_cast<std::chrono::microseconds>(end - start_).count();
        TimingProfiler::instance().record(name_, duration_us);
    }

private:
    std::string name_;
    std::chrono::high_resolution_clock::time_point start_;
};

#define QWEN3_TIMER(name) qwen3_asr::ScopedTimer _timer_##__LINE__(name)
#define QWEN3_TIMER_RESET() qwen3_asr::TimingProfiler::instance().reset()
#define QWEN3_TIMER_REPORT() qwen3_asr::TimingProfiler::instance().print_report()

#else

#define QWEN3_TIMER(name) ((void)0)
#define QWEN3_TIMER_RESET() ((void)0)
#define QWEN3_TIMER_REPORT() ((void)0)

#endif

} // namespace qwen3_asr
