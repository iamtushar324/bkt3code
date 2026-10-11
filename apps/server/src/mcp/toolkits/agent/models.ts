/**
 * T3-CUSTOM(expbkt3): a model by the name people use for it.
 *
 * An agent asks for "opus" or "codex", not for an instance id and a slug. The
 * catalog is the live one the composer shows (`ProviderRegistry`), so a
 * custom model or a second Claude account resolves the same way it does in
 * the app. A refusal lists what the caller can pass instead.
 */
import type { ModelSelection, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import * as Result from "effect/Result";

/** Family words and the driver whose catalog they pick from. */
const FAMILIES: ReadonlyArray<{
  readonly words: ReadonlyArray<string>;
  readonly driver: string;
  readonly pattern: RegExp;
}> = [
  { words: ["opus"], driver: "claudeAgent", pattern: /opus/i },
  { words: ["sonnet"], driver: "claudeAgent", pattern: /sonnet/i },
  { words: ["haiku"], driver: "claudeAgent", pattern: /haiku/i },
  { words: ["claude"], driver: "claudeAgent", pattern: /.*/ },
  { words: ["codex", "gpt", "openai"], driver: "codex", pattern: /.*/ },
];

const usable = (provider: ServerProvider) =>
  provider.enabled && provider.installed && provider.availability !== "unavailable";

/** The provider's default model first, then catalog order, without legacy models. */
const rankedModels = (provider: ServerProvider): ReadonlyArray<ServerProviderModel> =>
  provider.models
    .filter((model) => model.isLegacy !== true)
    .toSorted((left, right) => Number(right.isDefault === true) - Number(left.isDefault === true));

const names = (model: ServerProviderModel) =>
  [model.slug, model.name, model.shortName, ...(model.aliases ?? [])]
    .filter((name): name is string => name !== undefined)
    .map((name) => name.toLowerCase());

export interface ResolvedModel {
  readonly provider: ServerProvider;
  readonly model: ServerProviderModel;
}

/** Up to a dozen `provider/model` names, for refusals. */
export const describeModels = (providers: ReadonlyArray<ServerProvider>): string =>
  providers
    .filter(usable)
    .flatMap((provider) =>
      rankedModels(provider)
        .slice(0, 4)
        .map((model) => `${provider.instanceId}/${model.slug}`),
    )
    .slice(0, 12)
    .join(", ");

export function resolveModel(
  ref: string,
  providers: ReadonlyArray<ServerProvider>,
): Result.Result<ResolvedModel, string> {
  const wanted = ref.trim().toLowerCase();
  const live = providers.filter(usable);
  const [instancePart, modelPart] = wanted.includes("/")
    ? wanted.split("/", 2)
    : [undefined, wanted];
  const candidates =
    instancePart === undefined
      ? live
      : live.filter((provider) => provider.instanceId.toLowerCase() === instancePart);
  const target = modelPart ?? wanted;

  // An exact slug, name or alias wins over a family word.
  for (const provider of candidates) {
    const model = rankedModels(provider).find((candidate) => names(candidate).includes(target));
    if (model !== undefined) return Result.succeed({ provider, model });
  }
  if (instancePart === undefined) {
    const family = FAMILIES.find((candidate) => candidate.words.includes(target));
    if (family !== undefined) {
      for (const provider of live.filter((candidate) => candidate.driver === family.driver)) {
        const model = rankedModels(provider).find(
          (candidate) => family.pattern.test(candidate.slug) || family.pattern.test(candidate.name),
        );
        if (model !== undefined) return Result.succeed({ provider, model });
      }
    }
  }
  for (const provider of candidates) {
    const model = rankedModels(provider).find((candidate) =>
      names(candidate).some((name) => name.includes(target)),
    );
    if (model !== undefined) return Result.succeed({ provider, model });
  }
  return Result.fail(
    `No model on this server matches "${ref}". Use an alias (opus, sonnet, haiku, codex) or one of: ${describeModels(providers)}.`,
  );
}

/**
 * The selection for `resolved`, with `effort` set through the model's own
 * effort option when it has one.
 */
export function modelSelectionFor(
  resolved: ResolvedModel,
  effort: string | undefined,
): Result.Result<ModelSelection, string> {
  const base = { instanceId: resolved.provider.instanceId, model: resolved.model.slug };
  if (effort === undefined || effort.trim().length === 0) return Result.succeed(base);
  const wanted = effort.trim().toLowerCase();
  const descriptor = resolved.model.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.type === "select" && /effort/i.test(candidate.id),
  );
  if (descriptor === undefined || descriptor.type !== "select") {
    return Result.fail(`Model ${resolved.model.name} has no effort setting. Omit effort.`);
  }
  const choice = descriptor.options.find(
    (option) => option.id.toLowerCase() === wanted || option.label.toLowerCase() === wanted,
  );
  if (choice === undefined) {
    return Result.fail(
      `Model ${resolved.model.name} takes effort ${descriptor.options.map((option) => option.id).join(", ")}.`,
    );
  }
  return Result.succeed({ ...base, options: [{ id: descriptor.id, value: choice.id }] });
}
