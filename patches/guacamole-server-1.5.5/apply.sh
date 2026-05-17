#!/bin/sh
set -eu
ROOT=${GUACAMOLE_SERVER_ROOT:-/tmp/guacamole-server}
PATCH_DIR=${ZEPHYR_GUACD_PATCH_DIR:-/tmp/zephyr-guacd-patches}
cd "$ROOT"
cp "$PATCH_DIR/cliprdr.c" src/protocols/rdp/channels/cliprdr.c
cp "$PATCH_DIR/cliprdr.h" src/protocols/rdp/channels/cliprdr.h
