import { expect, spyOn, test } from "bun:test";
import { generateProjectName } from "../src/project-names";

test("generates lowercase color, noun, and two-digit number names", () => {
  const names = new Set<string>();
  for (let index = 0; index < 256; index++) {
    const name = generateProjectName(names);
    expect(name).toMatch(
      /^(aqua|black|blue|fuchsia|gray|green|lime|maroon|navy|olive|purple|red|silver|teal|white|yellow) [a-z]+ (0[1-9]|[1-9][0-9])$/,
    );
    expect(names.has(name)).toBe(false);
    names.add(name);
  }
});

test("pads 01 and keeps the upper bound at 99", () => {
  const random = spyOn(Math, "random").mockReturnValue(0);
  try {
    expect(generateProjectName()).toBe("aqua clover 01");
    random.mockReturnValue(1 - Number.EPSILON);
    expect(generateProjectName()).toBe("yellow door 99");
  } finally {
    random.mockRestore();
  }
});

test("collisions roll over to another noun and wrap without exceeding 99", () => {
  const random = spyOn(Math, "random").mockReturnValue(0);
  try {
    const used = Array.from(
      { length: 99 },
      (_, index) => `aqua clover ${String(index + 1).padStart(2, "0")}`,
    );
    expect(generateProjectName(used)).toBe("aqua pebble 01");
    random.mockReturnValue(1 - Number.EPSILON);
    expect(generateProjectName(["yellow door 99", "aqua clover 01"])).toBe(
      "aqua clover 02",
    );
  } finally {
    random.mockRestore();
  }
});
