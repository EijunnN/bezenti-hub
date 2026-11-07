/**
 * Whether `t3 join` takes the mode the Hub approved: a machine is dedicated to a Space only when
 * it asked with `--dedicated`, and one that asked is never registered as someone's personal
 * machine. Answers why not, or undefined.
 */
export const joinModeRefusal = (input: {
  /** `--dedicated`, as typed. */
  readonly asked: string | undefined;
  /** The Space the approval dedicates it to, if any. */
  readonly dedicatedTo: string | undefined;
  readonly approverLabel: string;
}): string | undefined => {
  if (input.asked !== undefined && input.dedicatedTo === undefined) {
    return `Not registered: ${input.approverLabel} approved it as their personal machine, not as one dedicated to ${input.asked}. Only the Owner dedicates machines; run \`t3 join --dedicated\` again and have the Owner approve it.`;
  }
  if (input.asked === undefined && input.dedicatedTo !== undefined) {
    return `Not registered: ${input.approverLabel} approved it as dedicated to ${input.dedicatedTo}, but this machine did not ask to be dedicated. Run \`t3 join --dedicated ${input.dedicatedTo}\` if that is what it is for.`;
  }
  return undefined;
};
