#!/bin/bash
# Understand: audio in, JSON out with codes and metadata
#
# Usage: ./ace-understand.sh input.wav (or input.mp3)

set -eu

if [ $# -lt 1 ]; then
    echo "Usage: $0 <input.wav|input.mp3>"
    exit 1
fi

input="$1"

../build/ace-understand \
    --models ../models \
    --src-audio "$input" \
    --request ace-understand.json \
    -o ace-understand-out.json
