-- The value list of positions starts with the legacy fixtures (LoadPositionData.php): the leader and the member.
-- Ids 1 and 2 are what the tests and the local seed rely on; a later slice adds positions as rows.
INSERT INTO "position" ("name") VALUES ('Leder'), ('Medlem') ON CONFLICT ("name") DO NOTHING;
