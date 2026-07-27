# Minimal formatter image for managed volume bases.
# Must contain mkfs.ext4; sbox never installs packages inside the formatter guest.
# Auto-built and loaded on first volume ensure as sbox-volume-formatter:1
# (see DEFAULT_VOLUME_FORMATTER_IMAGE / ensureFormatterImage).
FROM alpine:3.20
RUN apk add --no-cache e2fsprogs \
  && command -v mkfs.ext4
