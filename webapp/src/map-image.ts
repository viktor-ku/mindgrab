import { domToBlob, domToForeignObjectSvg } from "modern-screenshot";
import type { Options } from "modern-screenshot";

// Pictures of the map, drawn from a copy of it laid out for the picture: no
// selection, no tools, just the ideas and their links on the paper.
export interface MapImageOptions {
  // The canvas paper behind the ideas, or nothing.
  background: boolean;
  // Pixels per point of the map, for PNG.
  scale: number;
}

export type MapImageFormat = "png" | "svg";

// A PNG and the pixels it ended up with.
export interface MapPng {
  blob: Blob;
  width: number;
  height: number;
}

// Room around the ideas, in map points.
export const MAP_IMAGE_PADDING = 32;

// Marks the element holding an idea's text (see Node in App.tsx), for the
// copy to find.
const IDEA_TEXT_ATTRIBUTE = "data-idea-text";
const IDEA_TEXT = `[${IDEA_TEXT_ATTRIBUTE}]`;

// Browsers refuse canvases past a size and hand back an empty image. A PNG is
// drawn at the chosen scale within the most a browser allows, and again
// within Safari's tighter limits if that fails.
const CANVAS_LIMITS = [
  { side: 65_535, area: 268_435_456 },
  { side: 16_384, area: 16_777_216 },
];

// The pixels per point a PNG of this size gets within a canvas limit: the
// chosen scale, or less if that would be too big to draw.
export function pngScale(
  width: number,
  height: number,
  scale: number,
  limit = CANVAS_LIMITS[0],
) {
  if (!width || !height) return scale;
  return Math.min(
    scale,
    limit.side / width,
    limit.side / height,
    Math.sqrt(limit.area / (width * height)),
  );
}

const paper = () =>
  getComputedStyle(document.documentElement)
    .getPropertyValue("--paper")
    .trim() || "#efefed";

// Text measures a little differently in a picture than on the page, so an
// idea sized to fit its text exactly could wrap its last word, and a long one
// could break its lines elsewhere. The copy keeps each idea's size and the
// lines the page broke its text into, and doesn't wrap them again.
function lineBreaks(text: Text) {
  const value = text.data;
  const range = document.createRange();
  const lines: string[] = [];
  let start = 0;
  let top: number | undefined;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\n") {
      lines.push(value.slice(start, i));
      start = i + 1;
      top = undefined;
      continue;
    }
    range.setStart(text, i);
    range.setEnd(text, i + 1);
    const rect = range.getClientRects()[0];
    if (!rect) continue;
    if (top !== undefined && rect.top > top + rect.height / 2) {
      lines.push(value.slice(start, i).trimEnd());
      start = i;
    }
    top = rect.top;
  }
  lines.push(value.slice(start));
  return lines.join("\n");
}

// Runs on each copy as it is made, before it joins its parent. Every element
// carries its computed style inline, which makes custom properties redundant
// and, repeated on each element, most of an SVG's size. Tooltips have no use
// in a picture.
function adjustCopy(node: Node) {
  if (!(node instanceof HTMLElement || node instanceof SVGElement)) return;
  const style = node.style;
  for (let i = style.length - 1; i >= 0; i--) {
    const name = style.item(i);
    if (name.startsWith("--")) style.removeProperty(name);
  }
  node.removeAttribute("title");
  if (node.matches(IDEA_TEXT)) style.setProperty("white-space", "pre");
}

// Finishes the whole copy: each idea gets the lines it has on the page, and
// the attributes used to match them up go.
function finishCopy(scene: HTMLElement, zoom = 1) {
  const lines = new Map<string, string>();
  for (const idea of scene.querySelectorAll<HTMLElement>("[data-node-id]")) {
    const text = idea.querySelector(IDEA_TEXT)?.firstChild;
    if (text instanceof Text && idea.dataset.nodeId)
      lines.set(idea.dataset.nodeId, lineBreaks(text));
  }
  return (copy: Node) => {
    if (!(copy instanceof HTMLElement)) return;
    for (const idea of copy.querySelectorAll<HTMLElement>("[data-node-id]")) {
      const text = idea.querySelector(IDEA_TEXT);
      const value = lines.get(idea.dataset.nodeId ?? "");
      if (text && value !== undefined) text.textContent = value;
      idea.removeAttribute("data-node-id");
      text?.removeAttribute(IDEA_TEXT_ATTRIBUTE);
    }
    // A larger PNG lays the copy out larger rather than stretching a small
    // drawing: Safari draws shadows in the wrong place when it stretches one.
    if (zoom !== 1) {
      copy.style.setProperty("zoom", String(zoom));
      copy.style.setProperty("width", `${scene.offsetWidth}px`, "important");
      copy.style.setProperty("height", `${scene.offsetHeight}px`, "important");
    }
  };
}

// The styles of the copied ::before and ::after shadows go in one style
// sheet, custom properties and all; those go too.
function trimStyleSheet(svg: SVGSVGElement) {
  for (const sheet of svg.querySelectorAll("style"))
    sheet.textContent = (sheet.textContent ?? "").replace(
      /\s--[\w-]+:[^;]*;/g,
      "",
    );
}

async function drawPng(
  scene: HTMLElement,
  background: boolean,
  scale: number,
): Promise<MapPng> {
  const blob = await domToBlob(scene, {
    backgroundColor: background ? paper() : null,
    width: Math.floor(scene.offsetWidth * scale),
    height: Math.floor(scene.offsetHeight * scale),
    onCloneEachNode: adjustCopy,
    onCloneNode: finishCopy(scene, scale),
    onCreateForeignObjectSvg: trimStyleSheet,
    type: "image/png",
  });
  // A canvas the browser could not draw comes back as a few blank bytes.
  const header = new DataView(await blob.slice(0, 24).arrayBuffer());
  if (header.byteLength < 24 || header.getUint32(0) !== 0x89504e47)
    throw new Error("The map is too large to draw as an image.");
  return { blob, width: header.getUint32(16), height: header.getUint32(20) };
}

export async function mapPng(
  scene: HTMLElement,
  options: MapImageOptions,
): Promise<MapPng> {
  let failure: unknown;
  let tried: number | undefined;
  for (const limit of CANVAS_LIMITS) {
    const scale = pngScale(
      scene.offsetWidth,
      scene.offsetHeight,
      options.scale,
      limit,
    );
    if (scale === tried) continue;
    tried = scale;
    try {
      return await drawPng(scene, options.background, scale);
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

// Characters XML 1.0 does not allow anywhere, even escaped.
const XML_ILLEGAL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: These are the characters being removed.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// A vector picture: the ideas stay text, with the fonts embedded. Browsers
// draw it as is; some design tools don't read the HTML inside it.
export async function mapSvg(scene: HTMLElement, options: MapImageOptions) {
  const captureOptions: Options = {
    backgroundColor: options.background ? paper() : null,
    onCloneEachNode: adjustCopy,
    onCloneNode: finishCopy(scene),
    onCreateForeignObjectSvg: trimStyleSheet,
  };
  const svg = await domToForeignObjectSvg(scene, captureOptions);
  const markup = new XMLSerializer()
    .serializeToString(svg)
    .replace(XML_ILLEGAL, "");
  return new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${markup}`], {
    type: "image/svg+xml",
  });
}
