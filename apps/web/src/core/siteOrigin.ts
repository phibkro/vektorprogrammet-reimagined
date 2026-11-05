/**
 * The origin the system's own pages are served from (`https://…`, no trailing slash), for the links that a
 * message carries. `apps/web` provides it from the deployment's configuration.
 */
import { Context } from "effect";

export class SiteOrigin extends Context.Service<SiteOrigin, string>()(
  "@vektorprogrammet/domain/shared/SiteOrigin"
) {}
