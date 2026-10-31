// Ideas use a light fill so text stays readable; top-level ideas use the
// strong fill so each map has a clear center.
export const NODE_COLORS = [
  {
    value: "blue",
    label: "Blue",
    nodeClass: "bg-blue-50 text-blue-950 border-blue-300",
    rootClass: "bg-blue-600 text-white border-blue-700",
    swatchClass: "bg-blue-300 border-blue-500",
  },
  {
    value: "teal",
    label: "Teal",
    nodeClass: "bg-teal-50 text-teal-950 border-teal-300",
    rootClass: "bg-teal-600 text-white border-teal-700",
    swatchClass: "bg-teal-200 border-teal-500",
  },
  {
    value: "green",
    label: "Green",
    nodeClass: "bg-green-50 text-green-950 border-green-300",
    rootClass: "bg-green-600 text-white border-green-700",
    swatchClass: "bg-green-200 border-green-500",
  },
  {
    value: "amber",
    label: "Amber",
    nodeClass: "bg-amber-50 text-amber-950 border-amber-300",
    rootClass: "bg-amber-400 text-amber-950 border-amber-500",
    swatchClass: "bg-amber-200 border-amber-500",
  },
  {
    value: "orange",
    label: "Orange",
    nodeClass: "bg-orange-50 text-orange-950 border-orange-300",
    rootClass: "bg-orange-500 text-white border-orange-600",
    swatchClass: "bg-orange-200 border-orange-500",
  },
  {
    value: "rose",
    label: "Rose",
    nodeClass: "bg-rose-50 text-rose-950 border-rose-300",
    rootClass: "bg-rose-600 text-white border-rose-700",
    swatchClass: "bg-rose-200 border-rose-500",
  },
  {
    value: "violet",
    label: "Violet",
    nodeClass: "bg-violet-50 text-violet-950 border-violet-300",
    rootClass: "bg-violet-600 text-white border-violet-700",
    swatchClass: "bg-violet-200 border-violet-500",
  },
  {
    value: "slate",
    label: "Slate",
    nodeClass: "bg-white text-slate-900 border-slate-300",
    rootClass: "bg-slate-800 text-white border-slate-900",
    swatchClass: "bg-slate-200 border-slate-500",
  },
] as const;

export type NodeColor = (typeof NODE_COLORS)[number]["value"];

export function isNodeColor(value: unknown): value is NodeColor {
  return NODE_COLORS.some((color) => color.value === value);
}
