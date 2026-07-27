/**
 * Pinned volume formatter image reference.
 *
 * Default image is auto-built from the shipped `formatter/Dockerfile` on first
 * use. Override with `SBOX_VOLUME_FORMATTER_IMAGE` to supply an equivalent
 * image that already contains `mkfs.ext4`.
 */

export const DEFAULT_VOLUME_FORMATTER_IMAGE = "sbox-volume-formatter:1";

export function volumeFormatterImage(): string {
  const override = process.env["SBOX_VOLUME_FORMATTER_IMAGE"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return DEFAULT_VOLUME_FORMATTER_IMAGE;
}
