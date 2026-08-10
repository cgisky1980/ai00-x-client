#!/bin/bash

set -eu

../build/ace-lm \
    --models ../models \
    --request full.json

../build/ace-synth \
    --models ../models \
    --request full0.json
