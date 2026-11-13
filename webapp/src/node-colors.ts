import type { JSX } from "solid-js";
import type {
  Color,
  ColorFamily,
  ColorShade,
  NamedColor,
} from "./generated/mindgrab-state/model";
import { TAILWIND_PALETTE } from "./tailwind-palette";

// An idea's color is one Tailwind shade, such as "sky-400", that fills its card
// exactly, or one of the named colors ideas had before shades.
export type NodeColor = Color;

// The named colors keep their recipe: a light fill so text stays readable, the
// strong fill on a central idea so each map has a clear center, and links in
// the child's tint so a branch reads as one thing. Slate is the white card new
// ideas start with.
const NAMED: Record<
  NamedColor,
  { label: string; node: string; line: string; root: string }
> = {
  slate: {
    label: "White",
    node: "bg-white text-slate-900 border-slate-200",
    line: "stroke-slate-300",
    root: "bg-slate-800 text-white border-slate-900",
  },
  blue: {
    label: "Blue",
    node: "bg-blue-50 text-blue-950 border-blue-200",
    line: "stroke-blue-300",
    root: "bg-blue-600 text-white border-blue-700",
  },
  teal: {
    label: "Teal",
    node: "bg-teal-50 text-teal-950 border-teal-200",
    line: "stroke-teal-300",
    root: "bg-teal-600 text-white border-teal-700",
  },
  green: {
    label: "Green",
    node: "bg-green-50 text-green-950 border-green-200",
    line: "stroke-green-300",
    root: "bg-green-600 text-white border-green-700",
  },
  amber: {
    label: "Amber",
    node: "bg-amber-50 text-amber-950 border-amber-200",
    line: "stroke-amber-300",
    root: "bg-amber-400 text-amber-950 border-amber-500",
  },
  orange: {
    label: "Orange",
    node: "bg-orange-50 text-orange-950 border-orange-200",
    line: "stroke-orange-300",
    root: "bg-orange-500 text-white border-orange-600",
  },
  rose: {
    label: "Rose",
    node: "bg-rose-50 text-rose-950 border-rose-200",
    line: "stroke-rose-300",
    root: "bg-rose-600 text-white border-rose-700",
  },
  violet: {
    label: "Violet",
    node: "bg-violet-50 text-violet-950 border-violet-200",
    line: "stroke-violet-300",
    root: "bg-violet-600 text-white border-violet-700",
  },
};

export const COLOR_FAMILIES = Object.keys(TAILWIND_PALETTE) as ColorFamily[];
export const COLOR_SHADES: readonly ColorShade[] = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
];

export function parseShade(
  color: string,
): { family: ColorFamily; shade: ColorShade } | undefined {
  const match = /^([a-z]+)-([1-9]\d*)$/.exec(color);
  if (!match) return undefined;
  const family = match[1] as ColorFamily;
  const shade = Number(match[2]) as ColorShade;
  return Object.hasOwn(TAILWIND_PALETTE, family) && COLOR_SHADES.includes(shade)
    ? { family, shade }
    : undefined;
}

export function isNodeColor(value: unknown): value is NodeColor {
  return (
    typeof value === "string" &&
    (Object.hasOwn(NAMED, value) || parseShade(value) !== undefined)
  );
}

// What a person can choose for an idea, a quick color or new ideas: the white
// card or a Tailwind shade. The other named colors stay only where they are.
export const isPickable = (color: NodeColor) =>
  color === "slate" || parseShade(color) !== undefined;

export const shadeValue = (family: ColorFamily, shade: ColorShade) =>
  TAILWIND_PALETTE[family][shade].fill;

const capitalize = (text: string) => text[0].toUpperCase() + text.slice(1);

// A color's name. The white card is dark on a central idea, so there it goes
// by what it is on both: the default.
export function colorLabel(color: NodeColor, root = false) {
  const shade = parseShade(color);
  return shade
    ? `${capitalize(shade.family)} ${shade.shade}`
    : root && color === "slate"
      ? "Default"
      : NAMED[color as NamedColor].label;
}

// How a color draws: Tailwind classes for the named colors, the exact values
// for a shade.
export interface Look {
  class: string;
  style?: JSX.CSSProperties;
}

// The neighbouring shade `steps` darker (or lighter, past the darkest).
const step = (family: ColorFamily, shade: ColorShade, steps: number) => {
  const index = COLOR_SHADES.indexOf(shade) + steps;
  const clamped =
    index < COLOR_SHADES.length ? index : COLOR_SHADES.length * 2 - 2 - index;
  return shadeValue(family, COLOR_SHADES[clamped]);
};

// A shade fills the card as picked, on a central idea too. The edge is a
// shade or two darker. The text is white or black, whichever has the higher
// WCAG contrast with the fill, worked out ahead for the whole palette.
export function nodeLook(color: NodeColor | undefined, root: boolean): Look {
  const shade = color && parseShade(color);
  if (!shade) {
    const named = NAMED[(color as NamedColor) ?? "slate"] ?? NAMED.slate;
    return { class: root ? named.root : named.node };
  }
  const fill = shadeValue(shade.family, shade.shade);
  return {
    class: "",
    style: {
      "background-color": fill,
      "border-color": step(
        shade.family,
        shade.shade,
        shade.shade <= 200 ? 2 : 1,
      ),
      color: TAILWIND_PALETTE[shade.family][shade.shade].text,
    },
  };
}

// Links take the child's color; a pale shade would vanish against the paper,
// so those draw in the family's 300.
export function lineLook(color: NodeColor | undefined): Look {
  const shade = color && parseShade(color);
  if (!shade) {
    const named = NAMED[(color as NamedColor) ?? "slate"] ?? NAMED.slate;
    return { class: named.line };
  }
  return {
    class: "",
    style: {
      stroke: shadeValue(shade.family, shade.shade <= 200 ? 300 : shade.shade),
    },
  };
}
