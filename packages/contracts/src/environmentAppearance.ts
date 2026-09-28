// T3-CUSTOM(expbkt3): a host's shared nickname, icon and colour.
//
// Stored in the host's server settings (`environmentAppearance`), next to
// upstream's `environmentIcon`, so everyone connected to that host sees the
// same identity. Clients own the catalogues (see client-runtime's
// `state/environmentAppearance.ts`): ids are plain strings here, so an icon or
// colour added by a newer client still decodes on an older one, which falls
// back to its derived default for an id it does not know.
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ENVIRONMENT_NICKNAME_MAX_LENGTH = 40;

const EnvironmentAppearanceId = TrimmedNonEmptyString.check(Schema.isMaxLength(32));

export const EnvironmentAppearanceSetting = Schema.Struct({
  nickname: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(ENVIRONMENT_NICKNAME_MAX_LENGTH)),
  ),
  iconId: Schema.optionalKey(EnvironmentAppearanceId),
  colorId: Schema.optionalKey(EnvironmentAppearanceId),
});
export type EnvironmentAppearanceSetting = typeof EnvironmentAppearanceSetting.Type;
