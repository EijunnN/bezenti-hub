import { defineRule } from "@oxlint/plugins";

function staticTypeValue(value: unknown): string | null {
  const node = value as {
    type?: string;
    value?: unknown;
    expression?: { type?: string; value?: unknown; quasis?: Array<{ value: { cooked?: string } }> };
  } | null;
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "JSXExpressionContainer" && node.expression) {
    const expression = node.expression;
    if (expression.type === "Literal" && typeof expression.value === "string") {
      return expression.value;
    }
    if (expression.type === "TemplateLiteral" && expression.quasis?.length === 1) {
      return expression.quasis[0]?.value.cooked ?? null;
    }
  }
  return null;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow native <select> and <input type="checkbox"> in web code; use the design-system Select and Checkbox.',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;

        if (node.name.name === "select") {
          context.report({
            node,
            message:
              "Do not use a native <select>. Use Select, SelectTrigger, SelectValue, SelectPopup and SelectItem from components/ui/select.",
          });
          return;
        }

        if (node.name.name !== "input") return;
        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute") continue;
          if (attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "type") continue;
          if (staticTypeValue(attribute.value) !== "checkbox") continue;
          context.report({
            node,
            message:
              'Do not use a native <input type="checkbox">. Use Checkbox from components/ui/checkbox.',
          });
        }
      },
    };
  },
});
