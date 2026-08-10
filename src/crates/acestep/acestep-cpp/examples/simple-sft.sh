#!/bin/bash

set -eu

../build/ace-lm \
    --models ../models \
    --request simple-sft.json

../build/ace-synth \
    --models ../models \
    --request simple-sft0.json
