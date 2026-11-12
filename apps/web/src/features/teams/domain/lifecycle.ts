import { Schema } from "effect";

/** Projections of existing storage facts, never additional stored state. */
export const PersonState = Schema.TaggedUnion({
  Anonymised: {},
  Identifiable: {},
  Merged: {},
});

export const personState = (facts: {
  readonly anonymised: boolean;
  readonly merged: boolean;
}): typeof PersonState.Type => {
  if (facts.merged) {
    return PersonState.cases.Merged.make({});
  }

  return facts.anonymised
    ? PersonState.cases.Anonymised.make({})
    : PersonState.cases.Identifiable.make({});
};

export const TeamState = Schema.TaggedUnion({ Active: {}, Inactive: {} });

export const teamStateTag = (team: {
  readonly active: boolean;
}): (typeof TeamState.Type)["_tag"] => (team.active ? "Active" : "Inactive");

export const teamState = (team: {
  readonly active: boolean;
}): typeof TeamState.Type => TeamState.cases[teamStateTag(team)].make({});
