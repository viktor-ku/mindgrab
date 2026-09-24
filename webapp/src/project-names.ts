const colors = [
  "aqua",
  "black",
  "blue",
  "fuchsia",
  "gray",
  "green",
  "lime",
  "maroon",
  "navy",
  "olive",
  "purple",
  "red",
  "silver",
  "teal",
  "white",
  "yellow",
];

const nouns = [
  "clover",
  "pebble",
  "willow",
  "otter",
  "cloud",
  "acorn",
  "fern",
  "robin",
  "meadow",
  "moss",
  "blossom",
  "bunny",
  "sprout",
  "panda",
  "daisy",
  "door",
];

export function generateProjectName(
  existingNames: Iterable<string> = [],
): string {
  const used = new Set(existingNames);
  const count = colors.length * nouns.length * 99;
  const start = Math.floor(Math.random() * count);
  for (let offset = 0; offset < count; offset++) {
    const index = (start + offset) % count;
    const color = colors[Math.floor(index / (nouns.length * 99))];
    const noun = nouns[Math.floor(index / 99) % nouns.length];
    const number = String((index % 99) + 1).padStart(2, "0");
    const name = `${color} ${noun} ${number}`;
    if (!used.has(name)) return name;
  }

  throw new Error("All generated project names are already in use.");
}
