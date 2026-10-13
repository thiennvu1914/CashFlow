/**
 * How many days ahead reminder occurrences are materialized and shown — also the
 * window the dashboard's upcoming list uses for debt and loan due dates. Lives
 * outside the reminder service so UI code can read it without importing a
 * server module.
 */
export const OCCURRENCE_LOOKAHEAD_DAYS = 30
