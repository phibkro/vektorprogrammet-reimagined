-- The admin list is one row (spec 0006b): the lock that deactivate, reactivate, grantAdmin and revokeAdmin take first,
-- because whether an Active administrator is left spans every administrator. Its id is ADMIN_LIST_ID in the domain.
INSERT INTO "admin_list" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
