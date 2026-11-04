variable "supabase_project_ref" {
  type = string
}

variable "site_url" {
  type = string
}

variable "cloudflare_account_id" {
  type = string
}

variable "worker_name" {
  type = string
}

variable "server_dir" {
  description = "Cloudflare Vite plugin server output directory."
  type        = string
  default     = "../../apps/web/dist/server"
}

variable "database_url" {
  description = "Server-only restricted runtime PostgreSQL URL: non-owner, non-superuser, no RLS bypass or role administration. Never migration credentials."
  type        = string
  sensitive   = true
  # Terraform has no native PostgreSQL URL parser; restrict the authority and query to canonical forms.
  validation {
    condition = contains(
      ["vektor_runtime", "vektor_runtime.${var.supabase_project_ref}"],
      try(regex("^postgres(?:ql)?://([^:@/?#]+):[^@/?#]+@(?:\\[[0-9A-Fa-f:]+\\]|[A-Za-z0-9.-]+)(?::[0-9]+)?/[^?#]*(?:\\?sslmode=(?:disable|allow|prefer|require|verify-ca|verify-full))?$", var.database_url)[0], "")
    )
    error_message = "database_url must use the restricted runtime login and may contain only an sslmode query parameter."
  }
}

variable "supabase_url" {
  type = string
}

variable "supabase_publishable_key" {
  type = string
}

variable "supabase_secret_key" {
  type      = string
  sensitive = true
}

variable "turnstile_site_key" {
  type = string
}

variable "turnstile_secret_key" {
  type      = string
  sensitive = true
}
variable "capture_smtp" {
  description = "Operator-verified SMTP capture sink that cannot deliver real mail; never production SMTP."
  type = object({
    host         = string
    port         = number
    user         = string
    password     = string
    sender_email = string
  })
  sensitive = true
}
