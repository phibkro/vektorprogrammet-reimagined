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
  description = "Server-only PostgreSQL connection whose role owns the domain tables or has BYPASSRLS, with required Auth-schema reads. Never a browser role."
  type      = string
  sensitive = true
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
