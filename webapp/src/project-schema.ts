import { z } from "zod";
import { isNodeColor } from "./node-colors";
import type { NodeColor } from "./node-colors";
import type { LayoutAnchor, MindMapNode } from "./mind-map";

const PositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
const AnchorSchema = z.object({
  id: z.string().min(1),
  centerY: z.number().finite(),
});

function nodeSchema(depth: number): z.ZodType<MindMapNode> {
  return z.lazy(() =>
    z.object({
      id: z.string().min(1),
      text: z.string(),
      color: z.custom<NodeColor>(isNodeColor).optional(),
      position: PositionSchema.optional(),
      next:
        depth < 99
          ? z.array(nodeSchema(depth + 1)).optional()
          : z.array(z.never()).optional(),
    }),
  );
}

const NodeSchema = nodeSchema(0);

const ProjectV1Schema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1),
    nodes: z.array(NodeSchema),
    anchor: AnchorSchema.optional(),
    view: z.object({
      left: z.number().finite(),
      top: z.number().finite(),
      zoom: z.number().finite().min(0.25).max(2.5),
    }),
  })
  .superRefine((project, context) => {
    const ids = new Set<string>();
    function checkNodes(nodes: MindMapNode[], depth: number) {
      if (depth >= 100) {
        context.addIssue({
          code: "custom",
          message: "Node nesting is too deep.",
        });
        return;
      }
      for (const node of nodes) {
        if (ids.has(node.id)) {
          context.addIssue({
            code: "custom",
            message: "Node IDs must be unique.",
          });
        }
        ids.add(node.id);
        if (node.next) checkNodes(node.next, depth + 1);
      }
    }
    checkNodes(project.nodes, 0);
  });

export const ProjectFileSchema = z.discriminatedUnion("version", [
  ProjectV1Schema,
]);

export type Project = z.infer<typeof ProjectV1Schema> & {
  nodes: MindMapNode[];
  anchor?: LayoutAnchor;
};
