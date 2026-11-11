import { expect, test } from "bun:test";
import { panelEdges, panelInsets } from "../src/view-insets";

test("the open side panel takes its width from the map's room", () => {
  expect(panelInsets(1024, false)).toEqual({
    top: 76,
    right: 24,
    bottom: 72,
    left: 24,
  });
  expect(panelEdges(1024, true)).toEqual({ left: 0, right: 396 });
  expect(panelInsets(1024, true)).toMatchObject({ left: 24, right: 412 });
  // The panel is wider from the `xl` breakpoint.
  expect(panelEdges(1280, true)).toEqual({ left: 0, right: 460 });
});

test("a phone's full-screen panel takes no room from the map", () => {
  expect(panelEdges(639, true)).toEqual({ left: 0, right: 0 });
  expect(panelInsets(390, true)).toMatchObject({ left: 24, right: 24 });
});
