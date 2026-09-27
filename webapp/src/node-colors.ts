export const NODE_COLORS = [
  {
    value: "blue",
    label: "Blue",
    nodeClass: "bg-blue-300 text-blue-950 border-blue-500",
    swatchClass: "bg-blue-300 border-blue-500",
  },
  {
    value: "teal",
    label: "Teal",
    nodeClass: "bg-teal-200 text-teal-950 border-teal-500",
    swatchClass: "bg-teal-200 border-teal-500",
  },
  {
    value: "green",
    label: "Green",
    nodeClass: "bg-green-200 text-green-950 border-green-500",
    swatchClass: "bg-green-200 border-green-500",
  },
  {
    value: "amber",
    label: "Amber",
    nodeClass: "bg-amber-200 text-amber-950 border-amber-500",
    swatchClass: "bg-amber-200 border-amber-500",
  },
  {
    value: "orange",
    label: "Orange",
    nodeClass: "bg-orange-200 text-orange-950 border-orange-500",
    swatchClass: "bg-orange-200 border-orange-500",
  },
  {
    value: "rose",
    label: "Rose",
    nodeClass: "bg-rose-200 text-rose-950 border-rose-500",
    swatchClass: "bg-rose-200 border-rose-500",
  },
  {
    value: "violet",
    label: "Violet",
    nodeClass: "bg-violet-200 text-violet-950 border-violet-500",
    swatchClass: "bg-violet-200 border-violet-500",
  },
  {
    value: "slate",
    label: "Slate",
    nodeClass: "bg-slate-200 text-slate-950 border-slate-500",
    swatchClass: "bg-slate-200 border-slate-500",
  },
] as const;

export type NodeColor = (typeof NODE_COLORS)[number]["value"];

export function isNodeColor(value: unknown): value is NodeColor {
  return NODE_COLORS.some((color) => color.value === value);
}
