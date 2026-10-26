/**
 * The files domain as data (spec 0006): C11 uploads. Phase 1's `UploadFiles` capability was "any staff"; it is this
 * command, granted to a member of any team. An upload has two steps (`commands.ts`), and both ask the grant of this
 * command.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import * as Commands from "../kernel/commands.ts";
import * as Domain from "../kernel/domain.ts";
import * as Grant from "../kernel/grant.ts";
import * as Subject from "../kernel/subject.ts";
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

export const registerPublicFile = Rpc.make("registerPublicFile", {
  error: DomainErrorSchema,
  payload: StoredUpload,
  success: PublicFile,
}).annotate(
  Commands.Info,
  Commands.info({
    replaces: ["RULE-290"],
    summary: "Register an uploaded file so that it can be served.",
  })
);

export const FilesRpc = RpcGroup.make(registerPublicFile);

export const FilesDomain = Domain.make({
  commands: FilesRpc,
  grants: [Grant.make([Subject.member], ["registerPublicFile"], "all")],
  name: "files",
  reads: {},
  title: "Files",
});
