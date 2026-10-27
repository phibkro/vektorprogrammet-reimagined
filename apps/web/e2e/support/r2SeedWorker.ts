/** Minimal Worker required by Wrangler's local platform proxy while it initializes the e2e R2 binding. */
export default {
  fetch: () => new Response(null, { status: 404 }),
};
