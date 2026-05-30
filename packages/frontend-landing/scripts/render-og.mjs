#!/usr/bin/env node
/**
 * Render public/og-image.svg → public/og-image.png at 1200×630.
 *
 * Run after editing the SVG source:
 *   pnpm --filter frontend-landing og:render
 *
 * Twitter / Facebook / LinkedIn reject SVG og:images, so we ship a PNG.
 * Telegram, Discord, Slack accept SVG but the PNG works everywhere.
 */
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src  = join(root, "public", "og-image.svg");
const out  = join(root, "public", "og-image.png");

const info = await sharp(src, { density: 192 })
  .resize(1200, 630)
  .png({ quality: 95, compressionLevel: 9 })
  .toFile(out);

console.log(`og-image.png: ${info.width}x${info.height} · ${(info.size / 1024).toFixed(1)} KB`);
