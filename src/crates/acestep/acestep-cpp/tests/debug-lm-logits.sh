#!/bin/bash

cp ../examples/full.json .

../build/ace-lm \
    --models ../models \
    --request full.json \
    --dump-logits logits.bin \
    --dump-tokens tokens.csv

./debug-lm-logits.py ../checkpoints/acestep-5Hz-lm-4B logits.bin tokens.csv
