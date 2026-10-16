/** C3 home page helpers. Counts are real (RULE-075 offsets dropped at Checkpoint 1). */
import { DateTime } from "effect";

const SECOND = 1000;

const MINUTE = 60 * SECOND;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;
const pad = (value: number) => String(value).padStart(2, "0");

/**
 * RULE-070: admission countdown as `DDd HHt MMm SSs`, each part zero-padded to
 * at least two digits. Fixed legacy defect: values of 100 or more are not
 * truncated (150 days shows as `150d`). A past end shows all zeros.
 */
export const formatCountdown = (
  now: DateTime.DateTime,
  end: DateTime.DateTime
): string => {
  const remaining = Math.max(
    DateTime.toEpochMillis(end) - DateTime.toEpochMillis(now),
    0
  );

  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  const seconds = Math.floor((remaining % MINUTE) / SECOND);

  return `${pad(days)}d ${pad(hours)}t ${pad(minutes)}m ${pad(seconds)}s`;
};
