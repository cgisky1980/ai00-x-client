#!/bin/bash

set -eu

../build/ace-lm \
    --models ../models \
    --request partial-sft.json

../build/ace-synth \
    --models ../models \
    --request partial-sft0.json
