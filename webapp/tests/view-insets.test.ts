import { expect, test } from "bun:test";
import { panelEdges, panelInsets } from "../src/view-insets";

test("open panels take their width from the map's room on the right", () => {
  expect(panelInsets(1024, false, false)).toEqual({
    top: 76,
    right: 24,
    bottom: 72,
    left: 24,
  });
  // The outline drawer alone.
  expect(panelEdges(1024, true, false)).toEqual({ left: 0, right: 396 });
  expect(panelInsets(1024, true, false)).toMatchObject({
    left: 24,
    right: 412,
  });
  // The notes alone keep to the edge.
  expect(panelEdges(1024, false, true)).toEqual({ left: 0, right: 332 });
  // From 1024px the notes sit beside the drawer, 8px clear of it.
  expect(panelEdges(1024, true, true)).toEqual({ left: 0, right: 724 });
  expect(panelInsets(1024, true, true)).toMatchObject({
    left: 24,
    right: 740,
  });
  // Both panels are wider from the `xl` breakpoint.
  expect(panelEdges(1280, true, false)).toEqual({ left: 0, right: 460 });
  expect(panelEdges(1280, true, true)).toEqual({ left: 0, right: 852 });
});

test("below 1024px the notes cover the outline drawer", () => {
  expect(panelEdges(800, true, true)).toEqual({ left: 0, right: 396 });
  expect(panelEdges(800, false, true)).toEqual({ left: 0, right: 332 });
});

test("a phone's full-screen panel takes no room from the map", () => {
  expect(panelEdges(639, true, true)).toEqual({ left: 0, right: 0 });
  expect(panelInsets(390, true, true)).toMatchObject({ left: 24, right: 24 });
});
