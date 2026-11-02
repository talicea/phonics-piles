/**
 * Card formatting (optional). Lets a deck describe how its cards LOOK: font, colours, outline, border, corner marks, shape.
 * All values are plain data and strictly validated: colours must be hex, fonts come from a fixed list, numbers are range-checked,
 * so an uploaded deck can never inject CSS or markup.
 *
 * Geometry is relative (fractions of the card's width/height) so a card looks the same at any size.
 */
import { z } from 'zod';

export const FONT_IDS = ['default', 'serif', 'playwrite-co'] as const;
export type FontId = (typeof FONT_IDS)[number];

/** CSS font stacks for each font id. 'playwrite-co' is bundled with the app (client/public/fonts). */
export const FONT_STACKS: Record<FontId, string> = {
  default: '"Andika", "Lexend", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  serif: '"Times New Roman", Times, serif',
  'playwrite-co': '"PlaywriteCO", cursive',
};

const hexColor = z.string({ error: 'Colours must be strings like "#990000".' }).regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Colours must be hex like "#990000" or "#900".');
// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001F\u007F]*$/;

export const CornerSchema = z
  .object({
    text: z.string().min(1, 'Corner text must not be empty.').max(6, 'Corner text must be at most 6 characters.').refine((s) => s.trim().length > 0 && NO_CONTROL.test(s), 'Corner text must be visible text.'),
    color: hexColor.optional(),
    fontId: z.enum(FONT_IDS).optional(),
    /** Font size as a fraction of the card height. */
    size: z.number().min(0.02).max(0.2).optional(),
  })
  .strict();

export const CardStyleSchema = z
  .object({
    fontId: z.enum(FONT_IDS).optional(),
    fontWeight: z.number().int().min(100).max(900).optional(),
    /** Main text size as a fraction of the card height. */
    fontSize: z.number().min(0.1).max(0.9).optional(),
    /** Vertical position of the text baseline as a fraction of the card height. */
    glyphY: z.number().min(0.2).max(0.95).optional(),
    textColor: hexColor.optional(),
    /** Outline colour of the text (defaults to textColor). */
    outlineColor: hexColor.optional(),
    /** Outline thickness as a fraction of the font size (0 = none). */
    outlineWidth: z.number().min(0).max(0.2).optional(),
    background: hexColor.optional(),
    borderColor: hexColor.optional(),
    /** Border thickness as a fraction of the card width. */
    borderWidth: z.number().min(0).max(0.05).optional(),
    /** Corner rounding as a fraction of the card width. */
    cornerRadius: z.number().min(0).max(0.5).optional(),
    corners: z
      .object({ topLeft: CornerSchema.optional(), topRight: CornerSchema.optional(), bottomLeft: CornerSchema.optional(), bottomRight: CornerSchema.optional() })
      .strict()
      .optional(),
  })
  .strict();

export type CardStyle = z.infer<typeof CardStyleSchema>;
export type Corner = z.infer<typeof CornerSchema>;
export type CornerName = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
export const CORNER_NAMES: readonly CornerName[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

/** Fully-resolved style with every field present. */
export type ResolvedStyle = Required<Omit<CardStyle, 'corners'>> & { corners: NonNullable<CardStyle['corners']> };

/** Layout constants shared by the renderer and the HTML importer (measured from the original printable cards). */
export const CARD_GEOMETRY = {
  /** Card drawing space is VIEW_WIDTH units wide; its height is VIEW_WIDTH / aspectRatio. */
  viewWidth: 896,
  cornerInsetX: 70 / 896,
  cornerTopBaseline: 115 / 1345,
  cornerBottomBaseline: 1295 / 1345,
  cornerSize: 75 / 1345,
  /** Text is shrunk when wider than this fraction of the card (plus padding of 35.2 units each side). */
  maxTextWidth: 0.84,
  textPadding: 32 * 1.1,
  /** Shrinking pivots this far above the baseline (as a fraction of the font size). */
  pivotAboveBaseline: (721 - 573.5) / 592,
} as const;

export const DEFAULT_ASPECT_RATIO = 896 / 1345;

export function defaultStyleFor(fontId: FontId): ResolvedStyle {
  return {
    fontId,
    fontWeight: fontId === 'playwrite-co' ? 400 : 700,
    fontSize: 592 / 1345,
    glyphY: 721 / 1345,
    textColor: '#000000',
    outlineColor: '',
    outlineWidth: fontId === 'playwrite-co' ? 10.064 / 592 : 0,
    background: '#ffffff',
    borderColor: '#666666',
    borderWidth: 2 / 896,
    cornerRadius: 58.24 / 896,
    corners: {},
  };
}

/** Merge renderer defaults < deck-wide style < this card's own style. An empty outlineColor means "same as text". */
export function resolveCardStyle(deckStyle: CardStyle | undefined, cardStyle: CardStyle | undefined): ResolvedStyle {
  const fontId = cardStyle?.fontId ?? deckStyle?.fontId ?? 'default';
  const base = defaultStyleFor(fontId);
  const merged = { ...base, ...strip(deckStyle), ...strip(cardStyle) } as ResolvedStyle;
  merged.corners = { ...(deckStyle?.corners ?? {}), ...(cardStyle?.corners ?? {}) };
  merged.fontId = fontId;
  return merged;
}
function strip(s: CardStyle | undefined): Partial<CardStyle> {
  if (!s) return {};
  const { corners: _c, ...rest } = s;
  void _c;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
}
