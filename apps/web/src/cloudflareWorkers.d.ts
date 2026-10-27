/** EX-0022: this app uses DOM and Node types, so name the one Worker-only binding it reads at startup. */
declare module "cloudflare:workers" {
  export const env: { readonly BETTER_AUTH_SECRET?: string };
}
