/**
 * The files domain as data (spec 0006): C11 uploads. Phase 1's `UploadFiles` capability was "any staff"; it is this
 * command, granted to a member of any team. An upload has two steps (`commands.ts`), and both ask the grant of this
 * command.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  Info,
  grant,
  info,
  member,
  make as declareDomain,
} from "../kernel/domain.ts";
import { DomainErrorSchema } from "../shared/errors.ts";
import { FileKey } from "../shared/ids.ts";
import { StoredContentType } from "./fileType.ts";
import { PublicFile } from "./publicFile.ts";

/** The result of storing an upload (step 1); the input of registering it (step 2). */
export const StoredUpload = Schema.Struct({
  contentType: StoredContentType,
  key: FileKey,
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type StoredUpload = typeof StoredUpload.Type;

export const createPublicFile = Rpc.make("createPublicFile", {
  error: DomainErrorSchema,
  payload: StoredUpload,
  success: PublicFile,
}).annotate(
  Info,
  info({
    method: "create",
    replaces: ["RULE-290"],
    resource: "PublicFile",
    summary: "Register an uploaded file so that it can be served.",
  })
);

export const FilesRpc = RpcGroup.make(createPublicFile);

export const FilesDomain = declareDomain({
  commands: FilesRpc,
  grants: [grant([member], ["createPublicFile"], "all")],
  name: "files",
  reads: {},
  title: "Files",
});
