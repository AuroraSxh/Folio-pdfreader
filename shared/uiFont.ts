/** Application text sizes only; PDF rendering keeps its own scale. */
export const UI_FONT_SCALES = [1, 1.15, 1.3, 1.5] as const;
export const DEFAULT_UI_FONT_SCALE = 1;

export function normalizeUIFontScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_UI_FONT_SCALE;
  return UI_FONT_SCALES.reduce<number>((nearest, scale) =>
    Math.abs(scale - value) < Math.abs(nearest - value) ? scale : nearest,
  DEFAULT_UI_FONT_SCALE);
}
