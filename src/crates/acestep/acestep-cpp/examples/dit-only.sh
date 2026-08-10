#!/bin/bash

set -eu

../build/ace-synth \
    --models ../models \
    --request dit-only.json
