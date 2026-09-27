/** T3-CUSTOM(expbkt3): unit coverage for codename worktree branch allocation. */
import { describe, expect, it } from "vite-plus/test";

import { chooseWorktreeIdentity } from "./allocateWorktreeDirectory.ts";

const input = {
  seed: "t3code/2d633e64",
  legacyName: "t3code-2d633e64",
  takenDirectoryNames: new Set<string>(),
  takenBranchNames: new Set<string>(),
};

describe("chooseWorktreeIdentity", () => {
  it("uses one codename for the directory and prefixed branch", () => {
    const identity = chooseWorktreeIdentity(input);

    expect(identity.branchName).toBe(`t3code/${identity.directoryName}`);
    expect(identity.branchName).not.toBe(input.seed);
  });

  it("disambiguates local and remote branch collisions", () => {
    const first = chooseWorktreeIdentity(input);
    const afterLocalCollision = chooseWorktreeIdentity({
      ...input,
      takenBranchNames: new Set([first.branchName]),
    });
    const afterRemoteCollision = chooseWorktreeIdentity({
      ...input,
      takenBranchNames: new Set([`origin/${first.branchName}`]),
    });

    expect(afterLocalCollision.directoryName).not.toBe(first.directoryName);
    expect(afterLocalCollision.branchName).toBe(`t3code/${afterLocalCollision.directoryName}`);
    expect(afterRemoteCollision).toEqual(afterLocalCollision);
  });
});
