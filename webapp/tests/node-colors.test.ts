import { expect, test } from "bun:test";
import {
  contrast,
  installedTheme,
  luminance,
  readPalette,
} from "../scripts/tailwind-palette";
import {
  COLOR_FAMILIES,
  COLOR_SHADES,
  colorLabel,
  isNodeColor,
  lineLook,
  nodeLook,
  isPickable,
} from "../src/node-colors";
import { DEFAULT_QUICK_COLORS } from "../src/generated/mindgrab-state/model";
import { TAILWIND_PALETTE } from "../src/tailwind-palette";

test("the palette and its text colors match the installed Tailwind", () => {
  // Out of date after a Tailwind upgrade: run `bun --bun run palette`.
  expect(TAILWIND_PALETTE).toEqual(
    readPalette(installedTheme().css) as typeof TAILWIND_PALETTE,
  );
  expect(COLOR_FAMILIES).toHaveLength(26);
});

test("text is white or black, whichever contrasts more", () => {
  expect(luminance("oklch(100% 0 none)")).toBeCloseTo(1, 3);
  expect(luminance("oklch(0% 0 none)")).toBeCloseTo(0, 3);
  // Tailwind's blue-600 is #155dfc in sRGB: WCAG luminance 0.150.
  expect(luminance(TAILWIND_PALETTE.blue[600].fill)).toBeCloseTo(0.15, 2);
  expect(TAILWIND_PALETTE.blue[600].text).toBe("white");
  expect(TAILWIND_PALETTE.yellow[500].text).toBe("black");
  expect(TAILWIND_PALETTE.slate[950].text).toBe("white");
});

test("colors are the named colors or a Tailwind shade spelled one way", () => {
  for (const color of ["slate", "blue", "violet", "sky-400", "taupe-950"])
    expect(isNodeColor(color)).toBe(true);
  for (const color of [
    "",
    "sky",
    "Sky-400",
    "sky-450",
    "sky-0400",
    "red",
    "white",
    "constructor",
    "toString-400",
    "constructor-400",
    42,
    undefined,
  ])
    expect(isNodeColor(color)).toBe(false);
  for (const color of DEFAULT_QUICK_COLORS)
    expect(isPickable(color)).toBe(true);
  expect(DEFAULT_QUICK_COLORS[0]).toBe("slate");
  // Older named colors stay on ideas but are not offered.
  expect(isPickable("blue")).toBe(false);
  expect(isPickable("sky-400")).toBe(true);
  expect(colorLabel("slate")).toBe("White");
  expect(colorLabel("sky-400")).toBe("Sky 400");
});

test("a shade fills the card exactly and its text stays readable", () => {
  for (const family of COLOR_FAMILIES)
    for (const shade of COLOR_SHADES) {
      const look = nodeLook(`${family}-${shade}`, false);
      const fill = look.style?.["background-color"] as string;
      expect(fill).toBe(TAILWIND_PALETTE[family][shade].fill);
      expect(nodeLook(`${family}-${shade}`, true)).toEqual(look);
      const text = look.style?.color as "white" | "black";
      expect(text).toBe(TAILWIND_PALETTE[family][shade].text);
      // The better of white and black always clears WCAG AA for body text.
      expect(
        contrast(luminance(fill), text === "white" ? 1 : 0),
      ).toBeGreaterThanOrEqual(4.5);
    }
  // Pale shades would vanish as links on the paper.
  expect(lineLook("sky-50").style?.stroke).toBe(TAILWIND_PALETTE.sky[300].fill);
  expect(lineLook("sky-600").style?.stroke).toBe(
    TAILWIND_PALETTE.sky[600].fill,
  );
  // Named colors keep their classes, and the strong fill on a central idea.
  expect(nodeLook("blue", false).class).toContain("bg-blue-50");
  expect(nodeLook("blue", true).class).toContain("bg-blue-600");
  expect(nodeLook(undefined, false)).toEqual(nodeLook("slate", false));
});

test("the white card goes by Default on a central idea, where it is dark", () => {
  expect(colorLabel("slate")).toBe("White");
  expect(colorLabel("slate", true)).toBe("Default");
  // Shades fill a central idea as picked, so they keep their names.
  expect(colorLabel("sky-400", true)).toBe("Sky 400");
  expect(nodeLook("slate", true).class).toContain("bg-slate-800");
});
