import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-native-form-controls", {
  filename: "fixture.tsx",
});

describe("t3code/no-native-form-controls", () => {
  rule.valid(
    "allows the design-system components",
    `const el = <Select><SelectTrigger /><Checkbox checked /></Select>;`,
  );

  rule.valid("allows other native inputs", `const el = <input type="text" value="a" />;`);

  rule.invalid(
    "reports a native select",
    `const el = <select value="a"><option /></select>;`,
    (output) => {
      assert.match(output, /native <select>/);
    },
  );

  rule.invalid(
    "reports a native checkbox",
    `const el = <input type="checkbox" checked />;`,
    (output) => {
      assert.match(output, /type="checkbox"/);
    },
  );

  rule.invalid(
    "reports a checkbox type set through an expression",
    `const el = <input type={"checkbox"} />;`,
    (output) => {
      assert.match(output, /type="checkbox"/);
    },
  );

  rule.invalid(
    "reports a case-insensitive checkbox type",
    `const el = <input type="Checkbox" />;`,
    (output) => {
      assert.match(output, /checkbox/);
    },
  );

  rule.invalid(
    "reports a native radio",
    `const el = <input type="radio" name="a" />;`,
    (output) => {
      assert.match(output, /radio/);
    },
  );

  rule.invalid(
    "reports spread props, which may carry the type",
    `const el = <input {...props} />;`,
    (output) => {
      assert.match(output, /spread/);
    },
  );

  rule.invalid(
    "reports a type read from a variable",
    `const el = <input type={kind} />;`,
    (output) => {
      assert.match(output, /checkbox/);
    },
  );

  rule.invalid(
    "reports a conditional type with a checkbox branch",
    `const el = <input type={on ? "checkbox" : "text"} />;`,
    (output) => {
      assert.match(output, /checkbox/);
    },
  );

  rule.valid(
    "allows a conditional type that is never a checkbox or radio",
    `const el = <input type={on ? "search" : "text"} />;`,
  );

  rule.invalid(
    "reports a select reached through a string tag alias",
    `const Tag = "select"; const el = <Tag value="a" />;`,
    (output) => {
      assert.match(output, /native <select>/);
    },
  );

  rule.invalid(
    "reports createElement('select')",
    `const el = createElement("select", null);`,
    (output) => {
      assert.match(output, /native <select>/);
    },
  );

  rule.invalid(
    "reports React.createElement('select')",
    `const el = React.createElement("select");`,
    (output) => {
      assert.match(output, /native <select>/);
    },
  );

  rule.invalid(
    "reports createElement('input', { type: 'checkbox' })",
    `const el = createElement("input", { type: "checkbox" });`,
    (output) => {
      assert.match(output, /checkbox/);
    },
  );

  rule.invalid(
    "reports createElement('input') props that may carry the type",
    `const el = createElement("input", props);`,
    (output) => {
      assert.match(output, /checkbox/);
    },
  );

  rule.valid(
    "allows createElement('input', { type: 'text' })",
    `const el = createElement("input", { type: "text" });`,
  );
});
