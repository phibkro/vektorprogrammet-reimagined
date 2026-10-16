import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type { SchemaError } from "effect/Schema"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
// non-recursive definitions
export type BylineSummary = { readonly "id": string, readonly "slug": string, readonly "displayName": string, readonly "bio": string | null, readonly "avatarMediaId": string | null, readonly "avatarStorageKey"?: string | null, readonly "avatarAlt"?: string | null, readonly "avatarBlurhash"?: string | null, readonly "avatarDominantColor"?: string | null, readonly "websiteUrl": string | null, readonly "userId": string | null, readonly "isGuest": boolean, readonly "createdAt": string, readonly "updatedAt": string, readonly "locale": string, readonly "translationGroup": string | null, readonly "customFields"?: { readonly [x: string]: string | boolean | null } }
export const BylineSummary = Schema.Struct({ "id": Schema.String, "slug": Schema.String, "displayName": Schema.String, "bio": Schema.Union([Schema.String, Schema.Null]), "avatarMediaId": Schema.Union([Schema.String, Schema.Null]), "avatarStorageKey": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "avatarAlt": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "avatarBlurhash": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "avatarDominantColor": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "websiteUrl": Schema.Union([Schema.String, Schema.Null]), "userId": Schema.Union([Schema.String, Schema.Null]), "isGuest": Schema.Boolean, "createdAt": Schema.String, "updatedAt": Schema.String, "locale": Schema.String, "translationGroup": Schema.Union([Schema.String, Schema.Null]), "customFields": Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean, Schema.Null])).check(Schema.isPropertyNames(Schema.String).annotate({ "expected": "an object with property names matching the schema" }))) }).annotate({ "identifier": "BylineSummary" })
export type ContentSeo = { readonly "title": string | null, readonly "description": string | null, readonly "image": string | null, readonly "canonical": string | null, readonly "noIndex": boolean }
export const ContentSeo = Schema.Struct({ "title": Schema.Union([Schema.String, Schema.Null]), "description": Schema.Union([Schema.String, Schema.Null]), "image": Schema.Union([Schema.String, Schema.Null]), "canonical": Schema.Union([Schema.String, Schema.Null]), "noIndex": Schema.Boolean }).annotate({ "identifier": "ContentSeo" })
export type ReferenceEntryRef = { readonly "id": string, readonly "slug": string | null, readonly "collection": string, readonly "title": string | null, readonly "locale": string | null, readonly "translationGroup": string | null, readonly "sortOrder"?: number }
export const ReferenceEntryRef = Schema.Struct({ "id": Schema.String, "slug": Schema.Union([Schema.String, Schema.Null]), "collection": Schema.String, "title": Schema.Union([Schema.String, Schema.Null]), "locale": Schema.Union([Schema.String, Schema.Null]), "translationGroup": Schema.Union([Schema.String, Schema.Null]), "sortOrder": Schema.optionalKey(Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(-9007199254740991).annotate({ "expected": "a value greater than or equal to -9007199254740991" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" }))) }).annotate({ "identifier": "ReferenceEntryRef" })
export type ApiError = { readonly "success": false, readonly "error": { readonly "code": string, readonly "message": string } }
export const ApiError = Schema.Struct({ "success": Schema.Literal(false).annotate({ "description": "Discriminant: always false for errors" }), "error": Schema.Struct({ "code": Schema.String.annotate({ "description": "Machine-readable error code", "examples": ["NOT_FOUND"] }), "message": Schema.String.annotate({ "description": "Human-readable error message" }) }) }).annotate({ "identifier": "ApiError" })
export type ContentBylineInput = { readonly "bylineId": string, readonly "roleLabel"?: string | null } & { readonly [x: string]: Schema.Json }
export const ContentBylineInput = Schema.StructWithRest(Schema.Struct({ "bylineId": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "roleLabel": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])) }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))]).annotate({ "identifier": "ContentBylineInput" })
export type ContentSeoInput = { readonly "title"?: string | null, readonly "description"?: string | null, readonly "image"?: string | null, readonly "canonical"?: string | null, readonly "noIndex"?: boolean } & { readonly [x: string]: Schema.Json }
export const ContentSeoInput = Schema.StructWithRest(Schema.Struct({ "title": Schema.optionalKey(Schema.Union([Schema.String.check(Schema.isMaxCodePoints(200).annotate({ "expected": "a string with at most 200 code points" })), Schema.Null])), "description": Schema.optionalKey(Schema.Union([Schema.String.check(Schema.isMaxCodePoints(500).annotate({ "expected": "a string with at most 500 code points" })), Schema.Null])), "image": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "canonical": Schema.optionalKey(Schema.Union([Schema.String.annotate({ "format": "uri" }), Schema.Null])), "noIndex": Schema.optionalKey(Schema.Boolean) }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))]).annotate({ "identifier": "ContentSeoInput" })
export type ContentPublishBody = { readonly "_rev"?: string, readonly "overrideLock"?: boolean, readonly "publishedAt"?: string | string } & { readonly [x: string]: Schema.Json }
export const ContentPublishBody = Schema.StructWithRest(Schema.Struct({ "_rev": Schema.optionalKey(Schema.String.annotate({ "description": "Opaque revision token for optimistic concurrency" })), "overrideLock": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Write even though another editor holds this entry's edit lock. Without it the write is refused with 409 ENTRY_LOCKED." })), "publishedAt": Schema.optionalKey(Schema.Union([Schema.String.annotate({ "format": "date-time" }).check(Schema.isPattern(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$", "u")).annotate({ "expected": "a string matching the RegExp ^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$" })), Schema.String.check(Schema.isPattern(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$", "u")).annotate({ "expected": "a string matching the RegExp ^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$" }))]).annotate({ "description": "Optional ISO 8601 datetime to backdate the publish (e.g. when migrating content). Requires content:publish_any permission. Without this, existing published_at is preserved on re-publish." })) }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))]).annotate({ "identifier": "ContentPublishBody" })
export type EntryLockHolder = { readonly "userId": string, readonly "userName": string | null, readonly "acquiredAt": string, readonly "expiresAt": string }
export const EntryLockHolder = Schema.Struct({ "userId": Schema.String, "userName": Schema.Union([Schema.String, Schema.Null]), "acquiredAt": Schema.String, "expiresAt": Schema.String }).annotate({ "identifier": "EntryLockHolder" })
export type BlockTypeVersion = { readonly "id": string, readonly "blockTypeId": string, readonly "version": number, readonly "fields": ReadonlyArray<{ readonly "slug": string, readonly "label": string, readonly "type": "string" | "text" | "url" | "number" | "integer" | "boolean" | "datetime" | "select" | "multiSelect" | "portableText" | "image" | "file" | "repeater", readonly "required"?: boolean, readonly "defaultValue"?: Schema.Json, readonly "validation"?: { readonly "min"?: number, readonly "max"?: number, readonly "minLength"?: number, readonly "maxLength"?: number, readonly "pattern"?: string, readonly "options"?: ReadonlyArray<string>, readonly "subFields"?: ReadonlyArray<{ readonly "slug": string, readonly "type": "string" | "text" | "url" | "number" | "integer" | "boolean" | "datetime" | "select" | "image", readonly "label": string, readonly "required"?: boolean, readonly "options"?: ReadonlyArray<string> }>, readonly "minItems"?: number, readonly "maxItems"?: number, readonly "allowedMimeTypes"?: ReadonlyArray<string> }, readonly "options"?: { readonly "darkVariant"?: boolean } }>, readonly "fingerprint": string, readonly "active": boolean, readonly "unsupportedTypes"?: ReadonlyArray<{ readonly "type": string, readonly "path": string }>, readonly "createdAt": string, readonly "updatedAt": string }
export const BlockTypeVersion = Schema.Struct({ "id": Schema.String, "blockTypeId": Schema.String, "version": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" })).check(Schema.isGreaterThan(0).annotate({ "expected": "a value greater than 0" })), "fields": Schema.Array(Schema.Struct({ "slug": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxCodePoints(63).annotate({ "expected": "a string with at most 63 code points" })).check(Schema.isPattern(new RegExp("^[a-z][a-z0-9_]*$", "u")).annotate({ "expected": "a string matching the RegExp ^[a-z][a-z0-9_]*$" })), "label": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxCodePoints(200).annotate({ "expected": "a string with at most 200 code points" })), "type": Schema.Literals(["string", "text", "url", "number", "integer", "boolean", "datetime", "select", "multiSelect", "portableText", "image", "file", "repeater"]), "required": Schema.optionalKey(Schema.Boolean), "defaultValue": Schema.optionalKey(Schema.Json.annotate({ "expected": "JSON value" })), "validation": Schema.optionalKey(Schema.Struct({ "min": Schema.optionalKey(Schema.Finite), "max": Schema.optionalKey(Schema.Finite), "minLength": Schema.optionalKey(Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" }))), "maxLength": Schema.optionalKey(Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" }))), "pattern": Schema.optionalKey(Schema.String), "options": Schema.optionalKey(Schema.Array(Schema.String)), "subFields": Schema.optionalKey(Schema.Array(Schema.Struct({ "slug": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxCodePoints(63).annotate({ "expected": "a string with at most 63 code points" })).check(Schema.isPattern(new RegExp("^[a-z][a-z0-9_]*$", "u")).annotate({ "expected": "a string matching the RegExp ^[a-z][a-z0-9_]*$" })), "type": Schema.Literals(["string", "text", "url", "number", "integer", "boolean", "datetime", "select", "image"]), "label": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "required": Schema.optionalKey(Schema.Boolean), "options": Schema.optionalKey(Schema.Array(Schema.String)) })).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" }))), "minItems": Schema.optionalKey(Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" }))), "maxItems": Schema.optionalKey(Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(1).annotate({ "expected": "a value greater than or equal to 1" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" }))), "allowedMimeTypes": Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(64).annotate({ "expected": "a value with a length of at most 64" }))) })), "options": Schema.optionalKey(Schema.Struct({ "darkVariant": Schema.optionalKey(Schema.Boolean) })) })), "fingerprint": Schema.String, "active": Schema.Boolean, "unsupportedTypes": Schema.optionalKey(Schema.Array(Schema.Struct({ "type": Schema.String, "path": Schema.String }))), "createdAt": Schema.String, "updatedAt": Schema.String }).annotate({ "identifier": "BlockTypeVersion" })
export type UpdateFieldBody = { readonly "label"?: string, readonly "type"?: "string" | "text" | "url" | "number" | "integer" | "boolean" | "datetime" | "select" | "multiSelect" | "portableText" | "image" | "file" | "reference" | "json" | "slug" | "repeater" | "blocks", readonly "required"?: boolean, readonly "unique"?: boolean, readonly "defaultValue"?: Schema.Json, readonly "validation"?: { readonly "required"?: boolean, readonly "min"?: number, readonly "max"?: number, readonly "minLength"?: number, readonly "maxLength"?: number, readonly "pattern"?: string, readonly "options"?: ReadonlyArray<string>, readonly "subFields"?: ReadonlyArray<{ readonly "slug": string, readonly "type": "string" | "text" | "url" | "number" | "integer" | "boolean" | "datetime" | "select" | "image", readonly "label": string, readonly "required"?: boolean, readonly "options"?: ReadonlyArray<string> } & { readonly [x: string]: Schema.Json }>, readonly "minItems"?: number, readonly "maxItems"?: number, readonly "allowedMimeTypes"?: ReadonlyArray<string>, readonly "targetCollection"?: string, readonly "multiple"?: boolean, readonly "relation"?: string, readonly "relationSide"?: "parent" | "child", readonly "allowedTypes"?: ReadonlyArray<string>, readonly "retiredTypes"?: ReadonlyArray<string> } & { readonly [x: string]: Schema.Json } | null, readonly "widget"?: string, readonly "options"?: { readonly [x: string]: Schema.Json }, readonly "sortOrder"?: number, readonly "searchable"?: boolean, readonly "indexed"?: boolean, readonly "translatable"?: boolean } & { readonly [x: string]: Schema.Json }
export const UpdateFieldBody = Schema.StructWithRest(Schema.Struct({ "label": Schema.optionalKey(Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" }))), "type": Schema.optionalKey(Schema.Literals(["string", "text", "url", "number", "integer", "boolean", "datetime", "select", "multiSelect", "portableText", "image", "file", "reference", "json", "slug", "repeater", "blocks"])), "required": Schema.optionalKey(Schema.Boolean), "unique": Schema.optionalKey(Schema.Boolean), "defaultValue": Schema.optionalKey(Schema.Json.annotate({ "expected": "JSON value" })), "validation": Schema.optionalKey(Schema.Union([Schema.StructWithRest(Schema.Struct({ "required": Schema.optionalKey(Schema.Boolean), "min": Schema.optionalKey(Schema.Finite), "max": Schema.optionalKey(Schema.Finite), "minLength": Schema.optionalKey(Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" }))), "maxLength": Schema.optionalKey(Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" }))), "pattern": Schema.optionalKey(Schema.String), "options": Schema.optionalKey(Schema.Array(Schema.String)), "subFields": Schema.optionalKey(Schema.Array(Schema.StructWithRest(Schema.Struct({ "slug": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxCodePoints(63).annotate({ "expected": "a string with at most 63 code points" })).check(Schema.isPattern(new RegExp("^[a-z][a-z0-9_]*$", "u")).annotate({ "expected": "a string matching the RegExp ^[a-z][a-z0-9_]*$" })), "type": Schema.Literals(["string", "text", "url", "number", "integer", "boolean", "datetime", "select", "image"]), "label": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "required": Schema.optionalKey(Schema.Boolean), "options": Schema.optionalKey(Schema.Array(Schema.String)) }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))])).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" }))), "minItems": Schema.optionalKey(Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" }))), "maxItems": Schema.optionalKey(Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(1).annotate({ "expected": "a value greater than or equal to 1" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" }))), "allowedMimeTypes": Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isPattern(new RegExp("^[a-z0-9][a-z0-9!#$&^_+\\-.]*\\/[a-z0-9!#$&^_+\\-.]*$", "u")).annotate({ "expected": "a string matching the RegExp ^[a-z0-9][a-z0-9!#$&^_+\\-.]*\\/[a-z0-9!#$&^_+\\-.]*$" }))).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(64).annotate({ "expected": "a value with a length of at most 64" }))), "targetCollection": Schema.optionalKey(Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" }))), "multiple": Schema.optionalKey(Schema.Boolean), "relation": Schema.optionalKey(Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxCodePoints(63).annotate({ "expected": "a string with at most 63 code points" })).check(Schema.isPattern(new RegExp("^[a-z][a-z0-9_]*$", "u")).annotate({ "expected": "a string matching the RegExp ^[a-z][a-z0-9_]*$" }))), "relationSide": Schema.optionalKey(Schema.Literals(["parent", "child"])), "allowedTypes": Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxCodePoints(63).annotate({ "expected": "a string with at most 63 code points" })).check(Schema.isPattern(new RegExp("^[a-z][a-z0-9_]*$", "u")).annotate({ "expected": "a string matching the RegExp ^[a-z][a-z0-9_]*$" })))), "retiredTypes": Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxCodePoints(63).annotate({ "expected": "a string with at most 63 code points" })).check(Schema.isPattern(new RegExp("^[a-z][a-z0-9_]*$", "u")).annotate({ "expected": "a string matching the RegExp ^[a-z][a-z0-9_]*$" })))) }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))]), Schema.Null])), "widget": Schema.optionalKey(Schema.String), "options": Schema.optionalKey(Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" })).check(Schema.isPropertyNames(Schema.String).annotate({ "expected": "an object with property names matching the schema" }))), "sortOrder": Schema.optionalKey(Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" }))), "searchable": Schema.optionalKey(Schema.Boolean), "indexed": Schema.optionalKey(Schema.Boolean), "translatable": Schema.optionalKey(Schema.Boolean) }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))]).annotate({ "identifier": "UpdateFieldBody" })
export type BylineCredit = { readonly "byline": BylineSummary, readonly "sortOrder": number, readonly "roleLabel": string | null, readonly "source"?: "explicit" | "inferred" }
export const BylineCredit = Schema.Struct({ "byline": BylineSummary, "sortOrder": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(-9007199254740991).annotate({ "expected": "a value greater than or equal to -9007199254740991" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" })), "roleLabel": Schema.Union([Schema.String, Schema.Null]), "source": Schema.optionalKey(Schema.Literals(["explicit", "inferred"]).annotate({ "description": "Whether this credit was explicitly assigned or inferred from authorId" })) }).annotate({ "identifier": "BylineCredit" })
export type ReferenceChildrenResponse = { readonly "children": ReadonlyArray<ReferenceEntryRef>, readonly "nextCursor"?: string }
export const ReferenceChildrenResponse = Schema.Struct({ "children": Schema.Array(ReferenceEntryRef), "nextCursor": Schema.optionalKey(Schema.String) }).annotate({ "identifier": "ReferenceChildrenResponse" })
export type ContentCreateBody = { readonly "data": { readonly [x: string]: Schema.Json }, readonly "slug"?: string | null, readonly "status"?: "draft", readonly "bylines"?: ReadonlyArray<ContentBylineInput>, readonly "locale"?: string, readonly "translationOf"?: string, readonly "seo"?: ContentSeoInput, readonly "taxonomies"?: { readonly [x: string]: ReadonlyArray<string> }, readonly "references"?: { readonly [x: string]: ReadonlyArray<string> }, readonly "publishedAt"?: string | string | null, readonly "createdAt"?: string | string | null, readonly "migrateBlocks"?: boolean, readonly "replaceBlocks"?: boolean } & { readonly [x: string]: Schema.Json }
export const ContentCreateBody = Schema.StructWithRest(Schema.Struct({ "data": Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" })).check(Schema.isPropertyNames(Schema.String).annotate({ "expected": "an object with property names matching the schema" })), "slug": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "status": Schema.optionalKey(Schema.Literal("draft")), "bylines": Schema.optionalKey(Schema.Array(ContentBylineInput)), "locale": Schema.optionalKey(Schema.String.check(Schema.isPattern(new RegExp("^[a-z]{2,3}(-[a-z0-9]{2,8})*$", "u")).annotate({ "expected": "a string matching the RegExp ^[a-z]{2,3}(-[a-z0-9]{2,8})*$" }))), "translationOf": Schema.optionalKey(Schema.String), "seo": Schema.optionalKey(ContentSeoInput), "taxonomies": Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String)).annotate({ "description": "Taxonomy term assignments as { taxonomyName: [termSlug, ...] }, resolved in the entry's locale." }).check(Schema.isPropertyNames(Schema.String).annotate({ "expected": "an object with property names matching the schema" }))), "references": Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String).check(Schema.isMaxLength(1000).annotate({ "expected": "a value with a length of at most 1000" }))).annotate({ "description": "Reference selections as { fieldSlug: [entryId, ...] }, in display order. Written as content-reference links in the same transaction as the entry. A field bound to the child end of its relation selects the entries pointing at this one, which carry no order." }).check(Schema.isPropertyNames(Schema.String).annotate({ "expected": "an object with property names matching the schema" }))), "publishedAt": Schema.optionalKey(Schema.Union([Schema.Union([Schema.String.annotate({ "format": "date-time" }).check(Schema.isPattern(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$", "u")).annotate({ "expected": "a string matching the RegExp ^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$" })), Schema.String.check(Schema.isPattern(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$", "u")).annotate({ "expected": "a string matching the RegExp ^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$" }))]), Schema.Null])), "createdAt": Schema.optionalKey(Schema.Union([Schema.Union([Schema.String.annotate({ "format": "date-time" }).check(Schema.isPattern(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$", "u")).annotate({ "expected": "a string matching the RegExp ^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$" })), Schema.String.check(Schema.isPattern(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$", "u")).annotate({ "expected": "a string matching the RegExp ^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$" }))]), Schema.Null])), "migrateBlocks": Schema.optionalKey(Schema.Boolean), "replaceBlocks": Schema.optionalKey(Schema.Boolean) }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))]).annotate({ "identifier": "ContentCreateBody" })
export type BlockType = { readonly "id": string, readonly "slug": string, readonly "label": string, readonly "description"?: string, readonly "icon"?: string, readonly "category"?: string, readonly "currentVersion": number, readonly "source": "user" | "seed", readonly "versions": ReadonlyArray<BlockTypeVersion>, readonly "createdAt": string, readonly "updatedAt": string }
export const BlockType = Schema.Struct({ "id": Schema.String, "slug": Schema.String, "label": Schema.String, "description": Schema.optionalKey(Schema.String), "icon": Schema.optionalKey(Schema.String), "category": Schema.optionalKey(Schema.String), "currentVersion": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" })).check(Schema.isGreaterThan(0).annotate({ "expected": "a value greater than 0" })), "source": Schema.Literals(["user", "seed"]), "versions": Schema.Array(BlockTypeVersion), "createdAt": Schema.String, "updatedAt": Schema.String }).annotate({ "identifier": "BlockType" })
export type ContentItem = { readonly "id": string, readonly "type": string, readonly "slug": string | null, readonly "status": string, readonly "data": { readonly [x: string]: Schema.Json }, readonly "authorId": string | null, readonly "primaryBylineId": string | null, readonly "byline"?: BylineSummary | null, readonly "bylines"?: ReadonlyArray<BylineCredit>, readonly "createdAt": string, readonly "updatedAt": string, readonly "publishedAt": string | null, readonly "scheduledAt": string | null, readonly "liveRevisionId": string | null, readonly "draftRevisionId": string | null, readonly "version": number, readonly "locale": string | null, readonly "translationGroup": string | null, readonly "seo"?: ContentSeo, readonly "references"?: { readonly [x: string]: ReferenceChildrenResponse } }
export const ContentItem = Schema.Struct({ "id": Schema.String, "type": Schema.String.annotate({ "description": "Collection slug this item belongs to" }), "slug": Schema.Union([Schema.String, Schema.Null]), "status": Schema.String.annotate({ "description": "draft, published, or scheduled" }), "data": Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" })).annotate({ "description": "User-defined field values" }).check(Schema.isPropertyNames(Schema.String).annotate({ "expected": "an object with property names matching the schema" })), "authorId": Schema.Union([Schema.String, Schema.Null]), "primaryBylineId": Schema.Union([Schema.String, Schema.Null]), "byline": Schema.optionalKey(Schema.Union([BylineSummary, Schema.Null])), "bylines": Schema.optionalKey(Schema.Array(BylineCredit)), "createdAt": Schema.String, "updatedAt": Schema.String, "publishedAt": Schema.Union([Schema.String, Schema.Null]), "scheduledAt": Schema.Union([Schema.String, Schema.Null]), "liveRevisionId": Schema.Union([Schema.String, Schema.Null]), "draftRevisionId": Schema.Union([Schema.String, Schema.Null]), "version": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(-9007199254740991).annotate({ "expected": "a value greater than or equal to -9007199254740991" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" })), "locale": Schema.Union([Schema.String, Schema.Null]), "translationGroup": Schema.Union([Schema.String, Schema.Null]), "seo": Schema.optionalKey(ContentSeo), "references": Schema.optionalKey(Schema.Record(Schema.String, ReferenceChildrenResponse).check(Schema.isPropertyNames(Schema.String).annotate({ "expected": "an object with property names matching the schema" }))) }).annotate({ "identifier": "ContentItem" })
export type Field = { readonly "id": string, readonly "collectionId": string, readonly "slug": string, readonly "label": string, readonly "type": "string" | "text" | "url" | "number" | "integer" | "boolean" | "datetime" | "select" | "multiSelect" | "portableText" | "image" | "file" | "reference" | "json" | "slug" | "repeater" | "blocks", readonly "required": boolean, readonly "unique": boolean, readonly "defaultValue": Schema.Json | null, readonly "validation": { readonly [x: string]: Schema.Json } | null, readonly "widget": string | null, readonly "options": { readonly [x: string]: Schema.Json } | null, readonly "blockTypes"?: ReadonlyArray<BlockType>, readonly "blockTypeFingerprint"?: string, readonly "sortOrder": number, readonly "searchable": boolean, readonly "indexed": boolean, readonly "translatable": boolean, readonly "createdAt": string, readonly "updatedAt": string }
export const Field = Schema.Struct({ "id": Schema.String, "collectionId": Schema.String, "slug": Schema.String, "label": Schema.String, "type": Schema.Literals(["string", "text", "url", "number", "integer", "boolean", "datetime", "select", "multiSelect", "portableText", "image", "file", "reference", "json", "slug", "repeater", "blocks"]), "required": Schema.Boolean, "unique": Schema.Boolean, "defaultValue": Schema.Union([Schema.Json.annotate({ "expected": "JSON value" }), Schema.Null]), "validation": Schema.Union([Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" })).check(Schema.isPropertyNames(Schema.String).annotate({ "expected": "an object with property names matching the schema" })), Schema.Null]), "widget": Schema.Union([Schema.String, Schema.Null]), "options": Schema.Union([Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" })).check(Schema.isPropertyNames(Schema.String).annotate({ "expected": "an object with property names matching the schema" })), Schema.Null]), "blockTypes": Schema.optionalKey(Schema.Array(BlockType)), "blockTypeFingerprint": Schema.optionalKey(Schema.String), "sortOrder": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(-9007199254740991).annotate({ "expected": "a value greater than or equal to -9007199254740991" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" })), "searchable": Schema.Boolean, "indexed": Schema.Boolean, "translatable": Schema.Boolean, "createdAt": Schema.String, "updatedAt": Schema.String }).annotate({ "identifier": "Field" })
export type ContentListResponse = { readonly "items": ReadonlyArray<ContentItem>, readonly "nextCursor"?: string, readonly "total"?: number }
export const ContentListResponse = Schema.Struct({ "items": Schema.Array(ContentItem), "nextCursor": Schema.optionalKey(Schema.String), "total": Schema.optionalKey(Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" }))) }).annotate({ "identifier": "ContentListResponse" })
export type ContentResponse = { readonly "item": ContentItem, readonly "_rev"?: string }
export const ContentResponse = Schema.Struct({ "item": ContentItem, "_rev": Schema.optionalKey(Schema.String.annotate({ "description": "Opaque revision token for optimistic concurrency" })) }).annotate({ "identifier": "ContentResponse" })
export type FieldResponse = { readonly "item": Field }
export const FieldResponse = Schema.Struct({ "item": Field }).annotate({ "identifier": "FieldResponse" })
// schemas
export type ListContentParams = { readonly "cursor"?: string, readonly "limit"?: number, readonly "page"?: number, readonly "status"?: "draft" | "published" | "scheduled" | "archived" | "pending" | "private" | "future" | "all", readonly "orderBy"?: string, readonly "order"?: "asc" | "desc", readonly "locale"?: string, readonly "q"?: string, readonly "authorId"?: string, readonly "dateField"?: "createdAt" | "updatedAt" | "publishedAt", readonly "dateFrom"?: string | string | string, readonly "dateTo"?: string | string | string, readonly "bylines"?: string, readonly "includeInferredBylines"?: "0" | "1" | "true" | "false", readonly "fieldFilters"?: string }
export const ListContentParams = Schema.Struct({ "cursor": Schema.optionalKey(Schema.String.annotate({ "description": "Opaque cursor for pagination" }).check(Schema.isMaxCodePoints(2048).annotate({ "expected": "a string with at most 2048 code points" }))), "limit": Schema.optionalKey(Schema.Number.annotate({ "description": "Maximum number of items to return (1-100, default 50)", "default": 50 }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(1).annotate({ "expected": "a value greater than or equal to 1" })).check(Schema.isLessThanOrEqualTo(100).annotate({ "expected": "a value less than or equal to 100" }))), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "1-based page number, for numbered pages instead of a cursor" }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(1).annotate({ "expected": "a value greater than or equal to 1" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" }))), "status": Schema.optionalKey(Schema.Literals(["draft", "published", "scheduled", "archived", "pending", "private", "future", "all"])), "orderBy": Schema.optionalKey(Schema.String), "order": Schema.optionalKey(Schema.Literals(["asc", "desc"])), "locale": Schema.optionalKey(Schema.String.check(Schema.isPattern(new RegExp("^[a-z]{2,3}(-[a-z0-9]{2,8})*$", "u")).annotate({ "expected": "a string matching the RegExp ^[a-z]{2,3}(-[a-z0-9]{2,8})*$" }))), "q": Schema.optionalKey(Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxCodePoints(200).annotate({ "expected": "a string with at most 200 code points" }))), "authorId": Schema.optionalKey(Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxCodePoints(64).annotate({ "expected": "a string with at most 64 code points" }))), "dateField": Schema.optionalKey(Schema.Literals(["createdAt", "updatedAt", "publishedAt"])), "dateFrom": Schema.optionalKey(Schema.Union([Schema.Union([Schema.String.annotate({ "format": "date-time" }).check(Schema.isPattern(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$", "u")).annotate({ "expected": "a string matching the RegExp ^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$" })), Schema.String.check(Schema.isPattern(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$", "u")).annotate({ "expected": "a string matching the RegExp ^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$" }))]), Schema.String.annotate({ "format": "date" }).check(Schema.isPattern(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$", "u")).annotate({ "expected": "a string matching the RegExp ^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$" }))])), "dateTo": Schema.optionalKey(Schema.Union([Schema.Union([Schema.String.annotate({ "format": "date-time" }).check(Schema.isPattern(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$", "u")).annotate({ "expected": "a string matching the RegExp ^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$" })), Schema.String.check(Schema.isPattern(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$", "u")).annotate({ "expected": "a string matching the RegExp ^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$" }))]), Schema.String.annotate({ "format": "date" }).check(Schema.isPattern(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$", "u")).annotate({ "expected": "a string matching the RegExp ^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$" }))])), "bylines": Schema.optionalKey(Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxCodePoints(2000).annotate({ "expected": "a string with at most 2000 code points" }))), "includeInferredBylines": Schema.optionalKey(Schema.Literals(["0", "1", "true", "false"])), "fieldFilters": Schema.optionalKey(Schema.String.check(Schema.isMaxCodePoints(8192).annotate({ "expected": "a string with at most 8192 code points" }))) })
export type ListContent200 = { readonly "success": true, readonly "data": ContentListResponse }
export const ListContent200 = Schema.Struct({ "success": Schema.Literal(true).annotate({ "description": "Discriminant: always true for success" }), "data": ContentListResponse })
export type ListContent400 = ApiError
export const ListContent400 = ApiError
export type ListContent401 = ApiError
export const ListContent401 = ApiError
export type ListContent403 = ApiError
export const ListContent403 = ApiError
export type ListContent500 = ApiError
export const ListContent500 = ApiError
export type CreateContentRequestJson = ContentCreateBody
export const CreateContentRequestJson = ContentCreateBody
export type CreateContent201 = { readonly "success": true, readonly "data": ContentResponse }
export const CreateContent201 = Schema.Struct({ "success": Schema.Literal(true).annotate({ "description": "Discriminant: always true for success" }), "data": ContentResponse })
export type CreateContent400 = ApiError
export const CreateContent400 = ApiError
export type CreateContent401 = ApiError
export const CreateContent401 = ApiError
export type CreateContent403 = ApiError
export const CreateContent403 = ApiError
export type CreateContent422 = ApiError
export const CreateContent422 = ApiError
export type CreateContent500 = ApiError
export const CreateContent500 = ApiError
export type GetContentParams = { readonly "locale"?: string }
export const GetContentParams = Schema.Struct({ "locale": Schema.optionalKey(Schema.String.annotate({ "description": "Locale filter" })) })
export type GetContent200 = { readonly "success": true, readonly "data": ContentResponse }
export const GetContent200 = Schema.Struct({ "success": Schema.Literal(true).annotate({ "description": "Discriminant: always true for success" }), "data": ContentResponse })
export type GetContent401 = ApiError
export const GetContent401 = ApiError
export type GetContent403 = ApiError
export const GetContent403 = ApiError
export type GetContent404 = ApiError
export const GetContent404 = ApiError
export type GetContent500 = ApiError
export const GetContent500 = ApiError
export type PublishContentRequestJson = ContentPublishBody
export const PublishContentRequestJson = ContentPublishBody
export type PublishContent200 = { readonly "success": true, readonly "data": ContentResponse }
export const PublishContent200 = Schema.Struct({ "success": Schema.Literal(true).annotate({ "description": "Discriminant: always true for success" }), "data": ContentResponse })
export type PublishContent400 = ApiError
export const PublishContent400 = ApiError
export type PublishContent401 = ApiError
export const PublishContent401 = ApiError
export type PublishContent403 = ApiError
export const PublishContent403 = ApiError
export type PublishContent404 = ApiError
export const PublishContent404 = ApiError
export type PublishContent409 = { readonly "success": false, readonly "error": { readonly "code": string, readonly "message": string, readonly "details"?: EntryLockHolder } }
export const PublishContent409 = Schema.Struct({ "success": Schema.Literal(false), "error": Schema.Struct({ "code": Schema.String.annotate({ "examples": ["CONFLICT", "ENTRY_LOCKED"] }), "message": Schema.String, "details": Schema.optionalKey(EntryLockHolder) }) })
export type PublishContent500 = ApiError
export const PublishContent500 = ApiError
export type GetField200 = { readonly "success": true, readonly "data": FieldResponse }
export const GetField200 = Schema.Struct({ "success": Schema.Literal(true).annotate({ "description": "Discriminant: always true for success" }), "data": FieldResponse })
export type GetField401 = ApiError
export const GetField401 = ApiError
export type GetField403 = ApiError
export const GetField403 = ApiError
export type GetField404 = ApiError
export const GetField404 = ApiError
export type GetField500 = ApiError
export const GetField500 = ApiError
export type UpdateFieldRequestJson = UpdateFieldBody
export const UpdateFieldRequestJson = UpdateFieldBody
export type UpdateField200 = { readonly "success": true, readonly "data": FieldResponse }
export const UpdateField200 = Schema.Struct({ "success": Schema.Literal(true).annotate({ "description": "Discriminant: always true for success" }), "data": FieldResponse })
export type UpdateField400 = ApiError
export const UpdateField400 = ApiError
export type UpdateField401 = ApiError
export const UpdateField401 = ApiError
export type UpdateField403 = ApiError
export const UpdateField403 = ApiError
export type UpdateField404 = ApiError
export const UpdateField404 = ApiError
export type UpdateField500 = ApiError
export const UpdateField500 = ApiError

export interface OperationConfig {
  /**
   * Whether or not the response should be included in the value returned from
   * an operation.
   *
   * If set to `true`, a tuple of `[A, HttpClientResponse]` will be returned,
   * where `A` is the success type of the operation.
   *
   * If set to `false`, only the success type of the operation will be returned.
   */
  readonly includeResponse?: boolean | undefined
}

/**
 * A utility type which optionally includes the response in the return result
 * of an operation based upon the value of the `includeResponse` configuration
 * option.
 */
export type WithOptionalResponse<A, Config extends OperationConfig | undefined> = Config extends {
  readonly includeResponse: true
} ? [A, HttpClientResponse.HttpClientResponse]
  : Config extends { readonly includeResponse?: false | undefined } | undefined ? A
  : A | [A, HttpClientResponse.HttpClientResponse]

export const make = (
  httpClient: HttpClient.HttpClient,
  options: {
    readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined
  } = {}
): EmDash => {
  const unexpectedStatus = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.flatMap(
      Effect.orElseSucceed(response.json, () => "Unexpected status code"),
      (description) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({
              request: response.request,
              response,
              description: typeof description === "string" ? description : JSON.stringify(description),
            }),
          }),
        ),
    )
  const withResponse = <Config extends OperationConfig>(config: Config | undefined) => (
    f: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<any, any>,
  ): (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<any, any> => {
    const withOptionalResponse = (
      config?.includeResponse
        ? (response: HttpClientResponse.HttpClientResponse) => Effect.map(f(response), (a) => [a, response])
        : (response: HttpClientResponse.HttpClientResponse) => f(response)
    ) as any
    return options?.transformClient
      ? (request) =>
          Effect.flatMap(
            Effect.flatMap(options.transformClient!(httpClient), (client) => client.execute(request)),
            withOptionalResponse
          )
      : (request) => Effect.flatMap(httpClient.execute(request), withOptionalResponse)
  }
  const __encodePathParam = encodeURIComponent
  const __makePathRequest = (
    method: (url: string) => HttpClientRequest.HttpClientRequest,
    parameters: ReadonlyArray<string>,
    getPath: () => string,
  ) => Effect.suspend(() => {
    const fail = (description: string, cause?: unknown) => Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.InvalidUrlError({
          request: method(""),
          cause,
          description,
        }),
      }),
    )
    if (parameters.some((value) => value === "" || /^(?:\.|%2e){1,2}$/i.test(value))) {
      return fail("Path parameters must be non-empty and cannot be dot segments")
    }
    let path: string
    try {
      path = getPath()
    } catch (cause) {
      return fail("Failed to encode path parameter", cause)
    }
    if (path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) {
      return fail("Request paths cannot contain dot segments")
    }
    return Effect.succeed(method(path))
  })
  const decodeSuccess =
    <Schema extends Schema.Constraint>(schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response)
  const decodeError =
    <const Tag extends string, Schema extends Schema.Constraint>(tag: Tag, schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(schema)(response),
        (cause) => Effect.fail(EmDashError(tag, cause, response)),
      )
  return {
    httpClient,
    "listContent": (collection, options: Parameters<EmDash["listContent"]>[1]) => __makePathRequest(HttpClientRequest.get, [collection], () => "/_emdash/api/content/" + __encodePathParam(collection) + "").pipe(
    Effect.flatMap((request) => request.pipe(
      HttpClientRequest.setUrlParams({ "cursor": options?.params?.["cursor"] as any, "limit": options?.params?.["limit"] as any, "page": options?.params?.["page"] as any, "status": options?.params?.["status"] as any, "orderBy": options?.params?.["orderBy"] as any, "order": options?.params?.["order"] as any, "locale": options?.params?.["locale"] as any, "q": options?.params?.["q"] as any, "authorId": options?.params?.["authorId"] as any, "dateField": options?.params?.["dateField"] as any, "dateFrom": options?.params?.["dateFrom"] as any, "dateTo": options?.params?.["dateTo"] as any, "bylines": options?.params?.["bylines"] as any, "includeInferredBylines": options?.params?.["includeInferredBylines"] as any, "fieldFilters": options?.params?.["fieldFilters"] as any }),
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(ListContent200),
      "400": decodeError("ListContent400", ListContent400),
      "401": decodeError("ListContent401", ListContent401),
      "403": decodeError("ListContent403", ListContent403),
      "500": decodeError("ListContent500", ListContent500),
      orElse: unexpectedStatus
    }))
    ))
  ),
    "createContent": (collection, options: Parameters<EmDash["createContent"]>[1]) => __makePathRequest(HttpClientRequest.post, [collection], () => "/_emdash/api/content/" + __encodePathParam(collection) + "").pipe(
    Effect.flatMap((request) => request.pipe(
      HttpClientRequest.bodyJsonUnsafe(options.payload),
      withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateContent201),
      "400": decodeError("CreateContent400", CreateContent400),
      "401": decodeError("CreateContent401", CreateContent401),
      "403": decodeError("CreateContent403", CreateContent403),
      "422": decodeError("CreateContent422", CreateContent422),
      "500": decodeError("CreateContent500", CreateContent500),
      orElse: unexpectedStatus
    }))
    ))
  ),
    "getContent": (collection, id, options: Parameters<EmDash["getContent"]>[2]) => __makePathRequest(HttpClientRequest.get, [collection, id], () => "/_emdash/api/content/" + __encodePathParam(collection) + "/" + __encodePathParam(id) + "").pipe(
    Effect.flatMap((request) => request.pipe(
      HttpClientRequest.setUrlParams({ "locale": options?.params?.["locale"] as any }),
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetContent200),
      "401": decodeError("GetContent401", GetContent401),
      "403": decodeError("GetContent403", GetContent403),
      "404": decodeError("GetContent404", GetContent404),
      "500": decodeError("GetContent500", GetContent500),
      orElse: unexpectedStatus
    }))
    ))
  ),
    "publishContent": (collection, id, options: Parameters<EmDash["publishContent"]>[2]) => __makePathRequest(HttpClientRequest.post, [collection, id], () => "/_emdash/api/content/" + __encodePathParam(collection) + "/" + __encodePathParam(id) + "/publish").pipe(
    Effect.flatMap((request) => request.pipe(
      HttpClientRequest.bodyJsonUnsafe(options.payload),
      withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(PublishContent200),
      "400": decodeError("PublishContent400", PublishContent400),
      "401": decodeError("PublishContent401", PublishContent401),
      "403": decodeError("PublishContent403", PublishContent403),
      "404": decodeError("PublishContent404", PublishContent404),
      "409": decodeError("PublishContent409", PublishContent409),
      "500": decodeError("PublishContent500", PublishContent500),
      orElse: unexpectedStatus
    }))
    ))
  ),
    "getField": (slug, fieldSlug, options: Parameters<EmDash["getField"]>[2]) => __makePathRequest(HttpClientRequest.get, [slug, fieldSlug], () => "/_emdash/api/schema/collections/" + __encodePathParam(slug) + "/fields/" + __encodePathParam(fieldSlug) + "").pipe(
    Effect.flatMap((request) => request.pipe(
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetField200),
      "401": decodeError("GetField401", GetField401),
      "403": decodeError("GetField403", GetField403),
      "404": decodeError("GetField404", GetField404),
      "500": decodeError("GetField500", GetField500),
      orElse: unexpectedStatus
    }))
    ))
  ),
    "updateField": (slug, fieldSlug, options: Parameters<EmDash["updateField"]>[2]) => __makePathRequest(HttpClientRequest.put, [slug, fieldSlug], () => "/_emdash/api/schema/collections/" + __encodePathParam(slug) + "/fields/" + __encodePathParam(fieldSlug) + "").pipe(
    Effect.flatMap((request) => request.pipe(
      HttpClientRequest.bodyJsonUnsafe(options.payload),
      withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateField200),
      "400": decodeError("UpdateField400", UpdateField400),
      "401": decodeError("UpdateField401", UpdateField401),
      "403": decodeError("UpdateField403", UpdateField403),
      "404": decodeError("UpdateField404", UpdateField404),
      "500": decodeError("UpdateField500", UpdateField500),
      orElse: unexpectedStatus
    }))
    ))
  )
  }
}

export interface EmDash {
  readonly httpClient: HttpClient.HttpClient
  /**
* Returns a paginated list of content items in the specified collection.
*/
readonly "listContent": {
    <Config extends OperationConfig | undefined = undefined>(collection: string, options: { readonly params?: typeof ListContentParams.Encoded | undefined; readonly config: Config }): Effect.Effect<WithOptionalResponse<ListContent200, Config>, HttpClientError.HttpClientError | SchemaError | EmDashError<"ListContent400", ListContent400> | EmDashError<"ListContent401", ListContent401> | EmDashError<"ListContent403", ListContent403> | EmDashError<"ListContent500", ListContent500>>;
    <Config extends OperationConfig | undefined = undefined>(collection: string, options: { readonly params?: typeof ListContentParams.Encoded | undefined; readonly config?: Config | undefined } | undefined): Effect.Effect<WithOptionalResponse<ListContent200, Config | undefined>, HttpClientError.HttpClientError | SchemaError | EmDashError<"ListContent400", ListContent400> | EmDashError<"ListContent401", ListContent401> | EmDashError<"ListContent403", ListContent403> | EmDashError<"ListContent500", ListContent500>>;
  }
  /**
* Create a content item
*/
readonly "createContent": {
    <Config extends OperationConfig | undefined = undefined>(collection: string, options: { readonly payload: typeof CreateContentRequestJson.Encoded; readonly config: Config }): Effect.Effect<WithOptionalResponse<CreateContent201, Config>, HttpClientError.HttpClientError | SchemaError | EmDashError<"CreateContent400", CreateContent400> | EmDashError<"CreateContent401", CreateContent401> | EmDashError<"CreateContent403", CreateContent403> | EmDashError<"CreateContent422", CreateContent422> | EmDashError<"CreateContent500", CreateContent500>>;
    <Config extends OperationConfig | undefined = undefined>(collection: string, options: { readonly payload: typeof CreateContentRequestJson.Encoded; readonly config?: Config | undefined }): Effect.Effect<WithOptionalResponse<CreateContent201, Config | undefined>, HttpClientError.HttpClientError | SchemaError | EmDashError<"CreateContent400", CreateContent400> | EmDashError<"CreateContent401", CreateContent401> | EmDashError<"CreateContent403", CreateContent403> | EmDashError<"CreateContent422", CreateContent422> | EmDashError<"CreateContent500", CreateContent500>>;
  }
  /**
* Get a content item
*/
readonly "getContent": {
    <Config extends OperationConfig | undefined = undefined>(collection: string, id: string, options: { readonly params?: typeof GetContentParams.Encoded | undefined; readonly config: Config }): Effect.Effect<WithOptionalResponse<GetContent200, Config>, HttpClientError.HttpClientError | SchemaError | EmDashError<"GetContent401", GetContent401> | EmDashError<"GetContent403", GetContent403> | EmDashError<"GetContent404", GetContent404> | EmDashError<"GetContent500", GetContent500>>;
    <Config extends OperationConfig | undefined = undefined>(collection: string, id: string, options: { readonly params?: typeof GetContentParams.Encoded | undefined; readonly config?: Config | undefined } | undefined): Effect.Effect<WithOptionalResponse<GetContent200, Config | undefined>, HttpClientError.HttpClientError | SchemaError | EmDashError<"GetContent401", GetContent401> | EmDashError<"GetContent403", GetContent403> | EmDashError<"GetContent404", GetContent404> | EmDashError<"GetContent500", GetContent500>>;
  }
  /**
* Promotes the current draft to live content and clears any pending schedule. An optional revision token rejects stale publication attempts.
*/
readonly "publishContent": {
    <Config extends OperationConfig | undefined = undefined>(collection: string, id: string, options: { readonly payload: typeof PublishContentRequestJson.Encoded; readonly config: Config }): Effect.Effect<WithOptionalResponse<PublishContent200, Config>, HttpClientError.HttpClientError | SchemaError | EmDashError<"PublishContent400", PublishContent400> | EmDashError<"PublishContent401", PublishContent401> | EmDashError<"PublishContent403", PublishContent403> | EmDashError<"PublishContent404", PublishContent404> | EmDashError<"PublishContent409", PublishContent409> | EmDashError<"PublishContent500", PublishContent500>>;
    <Config extends OperationConfig | undefined = undefined>(collection: string, id: string, options: { readonly payload: typeof PublishContentRequestJson.Encoded; readonly config?: Config | undefined }): Effect.Effect<WithOptionalResponse<PublishContent200, Config | undefined>, HttpClientError.HttpClientError | SchemaError | EmDashError<"PublishContent400", PublishContent400> | EmDashError<"PublishContent401", PublishContent401> | EmDashError<"PublishContent403", PublishContent403> | EmDashError<"PublishContent404", PublishContent404> | EmDashError<"PublishContent409", PublishContent409> | EmDashError<"PublishContent500", PublishContent500>>;
  }
  /**
* Get a field
*/
readonly "getField": {
    <Config extends OperationConfig | undefined = undefined>(slug: string, fieldSlug: string, options: { readonly config: Config }): Effect.Effect<WithOptionalResponse<GetField200, Config>, HttpClientError.HttpClientError | SchemaError | EmDashError<"GetField401", GetField401> | EmDashError<"GetField403", GetField403> | EmDashError<"GetField404", GetField404> | EmDashError<"GetField500", GetField500>>;
    <Config extends OperationConfig | undefined = undefined>(slug: string, fieldSlug: string, options: { readonly config?: Config | undefined } | undefined): Effect.Effect<WithOptionalResponse<GetField200, Config | undefined>, HttpClientError.HttpClientError | SchemaError | EmDashError<"GetField401", GetField401> | EmDashError<"GetField403", GetField403> | EmDashError<"GetField404", GetField404> | EmDashError<"GetField500", GetField500>>;
  }
  /**
* Update a field
*/
readonly "updateField": {
    <Config extends OperationConfig | undefined = undefined>(slug: string, fieldSlug: string, options: { readonly payload: typeof UpdateFieldRequestJson.Encoded; readonly config: Config }): Effect.Effect<WithOptionalResponse<UpdateField200, Config>, HttpClientError.HttpClientError | SchemaError | EmDashError<"UpdateField400", UpdateField400> | EmDashError<"UpdateField401", UpdateField401> | EmDashError<"UpdateField403", UpdateField403> | EmDashError<"UpdateField404", UpdateField404> | EmDashError<"UpdateField500", UpdateField500>>;
    <Config extends OperationConfig | undefined = undefined>(slug: string, fieldSlug: string, options: { readonly payload: typeof UpdateFieldRequestJson.Encoded; readonly config?: Config | undefined }): Effect.Effect<WithOptionalResponse<UpdateField200, Config | undefined>, HttpClientError.HttpClientError | SchemaError | EmDashError<"UpdateField400", UpdateField400> | EmDashError<"UpdateField401", UpdateField401> | EmDashError<"UpdateField403", UpdateField403> | EmDashError<"UpdateField404", UpdateField404> | EmDashError<"UpdateField500", UpdateField500>>;
  }
}

export interface EmDashError<Tag extends string, E> {
  readonly _tag: Tag
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly cause: E
}

class EmDashErrorImpl extends Data.Error<{
  _tag: string
  cause: any
  request: HttpClientRequest.HttpClientRequest
  response: HttpClientResponse.HttpClientResponse
}> {}

export const EmDashError = <Tag extends string, E>(
  tag: Tag,
  cause: E,
  response: HttpClientResponse.HttpClientResponse,
): EmDashError<Tag, E> =>
  new EmDashErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request,
  }) as any