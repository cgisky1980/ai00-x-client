#!/bin/bash

set -eu

../build/ace-lm \
    --models ../models \
    --request partial.json

../build/ace-synth \
    --models ../models \
    --request partial0.json
