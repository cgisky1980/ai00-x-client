#!/bin/bash

set -eu

../build/ace-lm \
    --models ../models \
    --request simple.json

../build/ace-synth \
    --models ../models \
    --request simple0.json
