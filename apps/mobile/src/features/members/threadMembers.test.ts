// T3-CUSTOM(expbkt3): fork-owned coverage for thread member tagging.
import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationUser, UserId } from "@t3tools/contracts";

import {
  buildThreadMemberEntries,
  canRemoveThreadMember,
  filterThreadMemberEntries,
  threadMemberInitial,
  threadMemberLabel,
} from "./threadMembers";

const user = (id: string, overrides: Partial<OrchestrationUser> = {}): OrchestrationUser =>
  ({
    id,
    name: null,
    email: null,
    imageUrl: null,
    isAdmin: false,
    ...overrides,
  }) as OrchestrationUser;

describe("threadMemberLabel", () => {
  it("prefers a display name, then an email, then the raw id", () => {
    expect(threadMemberLabel(user("u1", { name: "Tushar" }))).toBe("Tushar");
    expect(threadMemberLabel(user("u2", { email: "a@b.com" }))).toBe("a@b.com");
    expect(threadMemberLabel(user("u3"))).toBe("u3");
  });
});

describe("threadMemberInitial", () => {
  it("uses the first letter of the label", () => {
    expect(threadMemberInitial(user("u1", { name: "tushar" }))).toBe("T");
  });

  it("falls back rather than rendering an empty circle", () => {
    expect(threadMemberInitial(user("", { name: "   " }))).toBe("?");
  });
});

describe("buildThreadMemberEntries", () => {
  const users = [
    user("zoe", { name: "Zoe" }),
    user("owner", { name: "Owner" }),
    user("amy", { name: "Amy" }),
    user("member", { name: "Member" }),
  ];

  it("puts the owner first, then members, then everyone else", () => {
    const entries = buildThreadMemberEntries({
      users,
      ownerUserId: "owner" as UserId,
      memberUserIds: ["member" as UserId],
    });
    expect(entries.map((entry) => entry.user.id)).toEqual(["owner", "member", "amy", "zoe"]);
  });

  it("marks ownership and membership", () => {
    const entries = buildThreadMemberEntries({
      users,
      ownerUserId: "owner" as UserId,
      memberUserIds: ["member" as UserId],
    });
    expect(entries[0]).toMatchObject({ isOwner: true });
    expect(entries[1]).toMatchObject({ isOwner: false, isMember: true });
    expect(entries[2]).toMatchObject({ isOwner: false, isMember: false });
  });

  it("sorts alphabetically when nobody is tagged", () => {
    const entries = buildThreadMemberEntries({ users, ownerUserId: null, memberUserIds: [] });
    expect(entries.map((entry) => entry.user.id)).toEqual(["amy", "member", "owner", "zoe"]);
  });
});

describe("filterThreadMemberEntries", () => {
  const entries = buildThreadMemberEntries({
    users: [
      user("a", { name: "Tushar Bhardwaj", email: "tushar@beknown.work" }),
      user("b", { name: "Someone Else", email: "else@example.com" }),
    ],
    ownerUserId: null,
    memberUserIds: [],
  });

  it("keeps everyone for an empty query", () => {
    expect(filterThreadMemberEntries(entries, "   ")).toHaveLength(2);
  });

  it("matches a partial name, case-insensitively", () => {
    expect(filterThreadMemberEntries(entries, "bhard").map((e) => e.user.id)).toEqual(["a"]);
  });

  it("matches an email prefix", () => {
    expect(filterThreadMemberEntries(entries, "else@").map((e) => e.user.id)).toEqual(["b"]);
  });

  it("returns nothing when nobody matches", () => {
    expect(filterThreadMemberEntries(entries, "zzz")).toEqual([]);
  });
});

describe("canRemoveThreadMember", () => {
  it("refuses to remove the owner", () => {
    expect(canRemoveThreadMember({ user: user("o"), isOwner: true, isMember: true })).toBe(false);
  });

  it("allows removing a plain member", () => {
    expect(canRemoveThreadMember({ user: user("m"), isOwner: false, isMember: true })).toBe(true);
  });

  it("has nothing to remove for a non-member", () => {
    expect(canRemoveThreadMember({ user: user("x"), isOwner: false, isMember: false })).toBe(false);
  });
});
