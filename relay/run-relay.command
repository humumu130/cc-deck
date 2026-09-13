#!/bin/bash
cd $HOME/dev/cc-deck/relay
export PATH=$HOME/node/bin:$PATH
export CCR_NOHOOK_IDLE_MS=60000
export CCR_TOKEN=mactest123457
exec npx tsx src/index.ts
