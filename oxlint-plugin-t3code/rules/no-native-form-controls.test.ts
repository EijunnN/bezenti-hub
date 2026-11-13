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

  rule.valid("allows radio inputs", `const el = <input type="radio" />;`);

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
});
