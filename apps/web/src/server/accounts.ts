/** Read models for Min side and the post-sign-in destination. */
import {
  ConsentRepository,
  CurrentPrincipal,
  DepartmentRepository,
  FieldOfStudyRepository,
  PersonRepository,
  consentSummary,
} from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Predicate } from "effect";

import { navigationFor } from "./shell";

export const signInDestination = Effect.gen(function* signInDestination() {
  const principal = yield* CurrentPrincipal;

  return Predicate.isTagged(principal, "Person") &&
    navigationFor(principal).length > 0
    ? "/kontrollpanel"
    : "/min-side";
});

export const myPage = Effect.gen(function* myPage() {
  const principal = yield* CurrentPrincipal;

  if (!Predicate.isTagged(principal, "Person")) {
    return { _tag: "Anonymous" as const };
  }

  const person = yield* (yield* PersonRepository).findById(principal.personId);

  const consents = consentSummary(
    yield* (yield* ConsentRepository).of(principal.personId)
  );

  const departments = yield* (yield* DepartmentRepository).list;
  const fields = yield* FieldOfStudyRepository;

  const options = yield* Effect.forEach(departments, (department) =>
    Effect.map(fields.listByDepartment(department.id), (rows) =>
      Arr.map(rows, (field) => ({
        id: field.id,
        label: `${department.name}: ${field.name}`,
      }))
    )
  );

  return {
    _tag: "Person" as const,
    consents,
    fieldsOfStudy: Arr.flatten(options),
    person,
  };
});
