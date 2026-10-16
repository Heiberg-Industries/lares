import sharp from "sharp";
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
/** Decode pixels and re-encode: never serve user markup, original metadata or animated payloads. */
export async function normalizeAvatar(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES)
    throw new Error("Choose a PNG, JPEG or WebP image up to 2 MB.");
  const source = sharp(bytes, {
    limitInputPixels: 16_000_000,
    animated: false,
  });
  const metadata = await source.metadata();
  if (
    !metadata.format ||
    !["png", "jpeg", "webp"].includes(metadata.format) ||
    (metadata.pages ?? 1) > 1
  )
    throw new Error("Choose a still PNG, JPEG or WebP image.");
  const image = await source
    .rotate()
    .resize(256, 256, { fit: "cover" })
    .webp({ quality: 85 })
    .toBuffer();
  if (image.length > 262144)
    throw new Error("The image is too complex. Choose a smaller image.");
  return image;
}
