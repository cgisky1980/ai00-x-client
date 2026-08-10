#!/bin/bash
# Generate 2 songs: LM produces 2 enriched requests (different codes/metas),
# DiT renders them in a single GPU batch.
#
# LM phase (lm_batch_size=2 in simple-batch.json):
# simple-batch.json : simple-batch0.json, simple-batch1.json
#
# DiT phase (both requests in one batch):
# simple-batch0.json + simple-batch1.json : simple-batch00.mp3, simple-batch11.mp3

set -eu

# Phase 1: LM generates 2 variations (different lyrics/codes/metas)
../build/ace-lm \
    --models ../models \
    --request simple-batch.json

# Phase 2: DiT+VAE renders both in one GPU batch
../build/ace-synth \
    --models ../models \
    --request simple-batch0.json simple-batch1.json
