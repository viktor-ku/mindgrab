import { expect, test } from "bun:test";
import { panelEdges, panelInsets } from "../src/view-insets";

test("open panels take their width from the map's room on wide screens", () => {
  expect(panelInsets(1024, false, false)).toEqual({
    top: 76,
    right: 24,
    bottom: 72,
    left: 24,
  });
  expect(panelEdges(1024, true, true)).toEqual({ left: 300, right: 332 });
  expect(panelInsets(1024, true, true)).toMatchObject({
    left: 316,
    right: 348,
  });
  // Both panels are wider from the `xl` breakpoint.
  expect(panelEdges(1280, true, true)).toEqual({ left: 332, right: 396 });
  expect(panelInsets(1280, true, false)).toMatchObject({
    left: 348,
    right: 24,
  });
});

test("a phone's full-screen panel takes no room from the map", () => {
  expect(panelEdges(639, true, true)).toEqual({ left: 0, right: 0 });
  expect(panelInsets(390, true, true)).toMatchObject({ left: 24, right: 24 });
});
