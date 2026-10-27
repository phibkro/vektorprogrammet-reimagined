/**
 * Aggregate ids. `@alchemy.run/domain` addresses an instance by a string (`Domain.Aggregate` takes an id schema whose
 * `Type` and `Encoded` are both `string`); the repository's ids are branded positive integers. The conversion is
 * here, once, and every command and every projection goes through it.
 */
import { ADMIN_LIST_ID } from "@vektorprogrammet/domain";
import type { PersonId } from "@vektorprogrammet/domain";
import { Schema } from "effect";

export const PersonKey = Schema.String.pipe(Schema.brand("PersonKey"));

export type PersonKeyValue = typeof PersonKey.Type;

export const AdminListKey = Schema.String.pipe(Schema.brand("AdminListKey"));

export type AdminListKeyValue = typeof AdminListKey.Type;

/** The instance of the `Person` aggregate for a person row. */
export const personKey = (personId: PersonId): PersonKeyValue =>
  PersonKey.make(String(personId));

/** The one instance of the `AdminList` aggregate: the repository's `admin_list` row, which has `id = 1`. */
export const ADMIN_LIST = AdminListKey.make(String(ADMIN_LIST_ID));
