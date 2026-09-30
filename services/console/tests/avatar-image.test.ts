import { expect, it } from "vitest";
import sharp from "sharp";
import { normalizeAvatar, MAX_AVATAR_BYTES } from "../lib/avatar-image";
it("decodes and crops an uploaded image to a metadata-free WebP", async () => {
  const png = await sharp({
    create: { width: 800, height: 400, channels: 3, background: "#88aaaa" },
  })
    .png()
    .toBuffer();
  const saved = await normalizeAvatar(png);
  const meta = await sharp(saved).metadata();
  expect(meta.format).toBe("webp");
  expect(meta.width).toBe(256);
  expect(meta.height).toBe(256);
  expect(meta.exif).toBeUndefined();
});
it("rejects markup, undecodable content and oversized payloads", async () => {
  await expect(
    normalizeAvatar(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>',
      ),
    ),
  ).rejects.toThrow();
  await expect(normalizeAvatar(Buffer.from("not an image"))).rejects.toThrow();
  await expect(
    normalizeAvatar(Buffer.alloc(MAX_AVATAR_BYTES + 1)),
  ).rejects.toThrow();
});
