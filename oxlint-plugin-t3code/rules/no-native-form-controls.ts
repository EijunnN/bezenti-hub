import { defineRule, type ESTree } from "@oxlint/plugins";

const SELECT_MESSAGE =
  "Do not use a native <select>. Use Select, SelectTrigger, SelectValue, SelectPopup and SelectItem from components/ui/select.";
const CHECKBOX_MESSAGE =
  'Do not use a native <input type="checkbox"> or <input type="radio">. Use Checkbox from components/ui/checkbox or RadioGroup from components/ui/radio-group.';
const UNPROVEN_MESSAGE =
  'This <input> may be a checkbox or radio: its type is not a literal other than those (spread props or a computed type hide it). Use Checkbox from components/ui/checkbox or RadioGroup from components/ui/radio-group, or give the input a literal type such as "text".';

const isCheckable = (value: string) => {
  const type = value.trim().toLowerCase();
  return type === "checkbox" || type === "radio";
};

/** True when the value is, or may be, "checkbox" or "radio" (anything not provably something else). */
function mayBeCheckable(node: ESTree.Node | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? isCheckable(node.value) : false;
    case "JSXExpressionContainer":
      return mayBeCheckable(node.expression as ESTree.Node);
    case "TemplateLiteral":
      return node.expressions.length > 0
        ? true
        : isCheckable(node.quasis[0]?.value.cooked ?? "checkbox");
    case "ConditionalExpression":
      return mayBeCheckable(node.consequent) || mayBeCheckable(node.alternate);
    case "LogicalExpression":
      return mayBeCheckable(node.left) || mayBeCheckable(node.right);
    default:
      return true;
  }
}

const stringLiteral = (node: ESTree.Node | undefined): string | null =>
  node !== undefined && node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : null;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow native <select> and checkbox/radio <input> in web code; use the design-system Select, Checkbox and RadioGroup.",
    },
  },
  create(context) {
    const selectAliases = new Set<string>();
    const inputAliases = new Set<string>();

    const checkInputProps = (props: ReadonlyArray<ESTree.Node>, node: ESTree.Node) => {
      let typeValue: ESTree.Node | null | undefined;
      let sawType = false;
      for (const prop of props) {
        if (prop.type === "JSXSpreadAttribute" || prop.type === "SpreadElement") {
          context.report({ node, message: UNPROVEN_MESSAGE });
          return;
        }
        if (prop.type === "JSXAttribute") {
          if (prop.name.type === "JSXIdentifier" && prop.name.name === "type") {
            sawType = true;
            typeValue = prop.value;
          }
        } else if (prop.type === "Property" && !prop.computed) {
          const key =
            prop.key.type === "Identifier" ? prop.key.name : stringLiteral(prop.key as ESTree.Node);
          if (key === "type") {
            sawType = true;
            typeValue = prop.value as ESTree.Node;
          }
        }
      }
      if (!sawType || !mayBeCheckable(typeValue)) return;
      const literal =
        typeValue?.type === "Literal" ||
        (typeValue?.type === "JSXExpressionContainer" &&
          (typeValue.expression as ESTree.Node).type === "Literal");
      context.report({ node, message: literal ? CHECKBOX_MESSAGE : UNPROVEN_MESSAGE });
    };

    return {
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier") return;
        const value = stringLiteral(node.init ?? undefined);
        if (value === "select") selectAliases.add(node.id.name);
        if (value === "input") inputAliases.add(node.id.name);
      },
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const name = node.name.name;
        if (name === "select" || selectAliases.has(name)) {
          context.report({ node, message: SELECT_MESSAGE });
          return;
        }
        if (name === "input" || inputAliases.has(name)) {
          checkInputProps(node.attributes as ReadonlyArray<ESTree.Node>, node);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        const isCreateElement =
          (callee.type === "Identifier" && callee.name === "createElement") ||
          (callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.property.type === "Identifier" &&
            callee.property.name === "createElement");
        if (!isCreateElement) return;
        const tagName = stringLiteral(node.arguments[0] as ESTree.Node | undefined);
        if (tagName === "select") {
          context.report({ node, message: SELECT_MESSAGE });
          return;
        }
        if (tagName !== "input") return;
        const props = node.arguments[1] as ESTree.Node | undefined;
        if (props === undefined || (props.type === "Literal" && props.value === null)) return;
        if (props.type !== "ObjectExpression") {
          context.report({ node, message: UNPROVEN_MESSAGE });
          return;
        }
        checkInputProps(props.properties as ReadonlyArray<ESTree.Node>, node);
      },
    };
  },
});
