# Retired prototype Terraform controller

The executable Terraform configuration is retired. The approved preview design uses Supabase-native branch management, Drizzle migrations and Alchemy for Cloudflare.

See [the application deployment guide](../../apps/web/README.md#deployment-and-verification) for the current workflow and setup requirements.

No Terraform apply or import is recorded for this checkout. The local directory contained provider caches, but no state file. Removing the configuration did not destroy remote resources.

If another operator applied the old configuration elsewhere, reconcile that state before any ownership transfer. Do not run `terraform destroy` to transfer ownership. Do not let Terraform and Alchemy manage the same Worker or Supabase configuration.

Local provider caches and state ignore rules remain. Do not publish state, plans, credentials or captured email links.
