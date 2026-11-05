locals {
  worker_config = jsondecode(file("${var.server_dir}/wrangler.json"))
  worker_entry  = "${var.server_dir}/${local.worker_config.main}"
  modules = setsubtract(
    setunion(fileset(var.server_dir, "**/*.js"), fileset(var.server_dir, "**/*.mjs")),
    toset([local.worker_config.main])
  )
}

# The project is pre-existing and operator-owned; only these settings are managed.
resource "supabase_settings" "prototype" {
  project_ref = var.supabase_project_ref

  # Domain tables are reached by the server over Postgres, not the Data API.
  api = jsonencode({
    db_schema = "storage,graphql_public"
  })
  auth = jsonencode({
    site_url                          = var.site_url
    uri_allow_list                    = var.site_url
    disable_signup                    = true
    external_email_enabled            = true
    external_anonymous_users_enabled  = false
    smtp_host                         = var.capture_smtp.host
    smtp_port                         = var.capture_smtp.port
    smtp_user                         = var.capture_smtp.user
    smtp_pass                         = var.capture_smtp.password
    smtp_admin_email                  = var.capture_smtp.sender_email
    smtp_sender_name                  = "Vektor prototype"
    mailer_templates_invite_content   = file("${path.module}/../../supabase/templates/invite.html")
    mailer_templates_recovery_content = file("${path.module}/../../supabase/templates/recovery.html")
  })
}

resource "cloudflare_workers_script" "web" {
  account_id          = var.cloudflare_account_id
  script_name         = var.worker_name
  content_file        = local.worker_entry
  content_sha256      = filesha256(local.worker_entry)
  main_module         = local.worker_config.main
  compatibility_date  = local.worker_config.compatibility_date
  compatibility_flags = local.worker_config.compatibility_flags

  files = { for name in local.modules : name => {
    content_file = "${var.server_dir}/${name}"
    content_type = "application/javascript+module"
  } }

  assets = { directory = "${var.server_dir}/${local.worker_config.assets.directory}" }

  bindings = concat([
    { name = "ASSETS", type = "assets" },
    { name = "DATABASE_URL", type = "secret_text", text = var.database_url },
    { name = "SUPABASE_URL", type = "plain_text", text = var.supabase_url },
    { name = "SUPABASE_PUBLISHABLE_KEY", type = "plain_text", text = var.supabase_publishable_key },
    { name = "SUPABASE_SECRET_KEY", type = "secret_text", text = var.supabase_secret_key },
    { name = "SITE_URL", type = "plain_text", text = var.site_url },
    { name = "DEPLOYMENT", type = "plain_text", text = "preview" },
    { name = "TURNSTILE_SITE_KEY", type = "plain_text", text = var.turnstile_site_key },
    { name = "TURNSTILE_SECRET_KEY", type = "secret_text", text = var.turnstile_secret_key }
    ], [for rate in local.worker_config.ratelimits : {
      name = rate.name, type = "ratelimit", namespace_id = rate.namespace_id, simple = rate.simple
  }])
}

resource "cloudflare_workers_cron_trigger" "web" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.web.script_name
  schedules   = [for cron in local.worker_config.triggers.crons : { cron = cron }]
}
