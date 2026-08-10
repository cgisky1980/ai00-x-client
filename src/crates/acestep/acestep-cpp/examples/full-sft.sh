#!/bin/bash

set -eu

../build/ace-lm \
    --models ../models \
    --request full-sft.json

../build/ace-synth \
    --models ../models \
    --request full-sft0.json
