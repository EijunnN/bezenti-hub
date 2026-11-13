import type { SpaceId } from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export type UsedBy = "personal" | SpaceId;

/** Who uses a machine: its owner alone, or everyone in one Organization it is dedicated to. */
export function UsedBySelect(props: {
  readonly id: string;
  readonly spaces: ReadonlyArray<{ readonly id: SpaceId; readonly name: string }>;
  readonly value: UsedBy;
  readonly disabled: boolean;
  readonly onChange: (value: UsedBy) => void;
}) {
  const listed =
    props.value === "personal" || props.spaces.some((space) => space.id === props.value);
  const items: ReadonlyArray<{ value: string; label: string; disabled: boolean }> = [
    { value: "personal", label: "Only me (personal machine)", disabled: false },
    // An Organization archived since, still named so the trigger never shows an id.
    ...(listed
      ? []
      : [
          {
            value: props.value,
            label: "An Organization that is no longer available",
            disabled: true,
          },
        ]),
    ...props.spaces.map((space) => ({
      value: space.id,
      label: `Everyone in ${space.name} (dedicated)`,
      disabled: false,
    })),
  ];
  return (
    <Select<string>
      disabled={props.disabled}
      items={items}
      value={props.value}
      onValueChange={(value) => {
        if (value !== null) props.onChange(value === "personal" ? "personal" : (value as SpaceId));
      }}
    >
      <SelectTrigger id={props.id}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} disabled={item.disabled}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
