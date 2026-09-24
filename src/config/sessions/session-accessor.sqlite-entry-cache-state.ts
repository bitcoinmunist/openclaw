import type { DatabaseSync } from "node:sqlite";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import type { SessionEntryCacheSnapshot } from "./session-accessor.sqlite-entry-cache.types.js";
import {
  cacheValidityTokensEqual,
  readSessionEntryCacheValidityToken,
  type SqliteSessionEntryRevision,
} from "./session-accessor.sqlite-entry-revision.js";
import type { SessionParticipantProjection } from "./session-membership-facts.types.js";

export type SqliteSessionEntryCache = SessionEntryCacheSnapshot & {
  validityToken: SqliteSessionEntryRevision;
};

// Retain listing metadata only; complete prompt snapshots belong to the caller's full read.
// Weak connection ownership lets closed read-only and evicted database handles release their
// snapshots. The connection-local validity token plus tracked-write invalidation keeps live
// snapshots current; narrow tracked upserts patch one authoritative row after commit, while
// structural/unknown writes invalidate. Without both, every read would re-query and re-parse
// every entry_json document.
export const sessionEntryCaches = new WeakMap<DatabaseSync, SqliteSessionEntryCache>();

/** Participant display facts may be borrowed in a transaction only at its native revision. */
export function readCurrentSessionEntryCacheParticipants(
  database: DatabaseSync,
  sessionKey: string,
): SessionParticipantProjection | undefined {
  const cached = sessionEntryCaches.get(database);
  const entry = cached?.entries.get(sessionKey);
  if (
    !cached ||
    !entry ||
    !getAdmittedSqliteSchemaFacts(database) ||
    !cacheValidityTokensEqual(
      cached.validityToken,
      readSessionEntryCacheValidityToken(database, "cached"),
    )
  ) {
    return undefined;
  }
  return entry.participants
    ? {
        participants: entry.participants.map(({ identity }) => ({ identity: { ...identity } })),
        participantCount: entry.participantCount,
      }
    : {};
}
