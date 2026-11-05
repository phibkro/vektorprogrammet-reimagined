ALTER TABLE "auth_account" DROP CONSTRAINT "auth_account_user_id_auth_user_id_fkey";--> statement-breakpoint
ALTER TABLE "auth_session" DROP CONSTRAINT "auth_session_user_id_auth_user_id_fkey";--> statement-breakpoint
DROP TABLE "auth_account";--> statement-breakpoint
DROP TABLE "auth_session";--> statement-breakpoint
DROP TABLE "auth_user";--> statement-breakpoint
DROP TABLE "auth_verification";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_kind", ADD CONSTRAINT "outbox_kind" CHECK ("kind" in ('DeleteAuthUser', 'RelinkAuthUser', 'Email', 'IssueCode', 'InviteAccount', 'SlackPost', 'WorkspaceChange'));