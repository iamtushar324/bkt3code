/**
 * T3-CUSTOM(expbkt3): Claude account profiles per thread — badge labels.
 *
 * Each account gets the shortest lowercase prefix of its name that no other
 * account shares (`tushar` → `t`, but `agent`/`audit` → `ag`/`au`). Operator
 * overrides from `experimental.claudeAccountProfiles.shortLabels` win, and an
 * override may claim a prefix another name would otherwise have needed
 * (`{ agent: "a" }` beside `audit` is fine: `audit` still becomes `au`).
 */
export function computeShortLabels(
  names: ReadonlyArray<string>,
  overrides: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {};
  const taken = new Set<string>();
  const overridden = new Set<string>();

  for (const name of names) {
    const override = overrides[name]?.trim();
    if (override) {
      labels[name] = override;
      taken.add(override.toLowerCase());
      overridden.add(name);
    }
  }

  const lowered = names.map((name) => name.toLowerCase());
  for (const [index, name] of names.entries()) {
    if (overridden.has(name)) continue;
    const self = lowered[index]!;
    // Overridden names no longer compete for a prefix; every other name does,
    // whether or not it has been labelled yet in this pass.
    const others = lowered.filter(
      (_, otherIndex) => otherIndex !== index && !overridden.has(names[otherIndex]!),
    );
    let label = self;
    for (let length = 1; length <= self.length; length += 1) {
      const candidate = self.slice(0, length);
      const collides = others.some((other) => other.startsWith(candidate)) || taken.has(candidate);
      if (!collides) {
        label = candidate;
        break;
      }
    }
    labels[name] = label;
    taken.add(label);
  }

  return labels;
}
