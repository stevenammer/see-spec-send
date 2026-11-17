# Hosting design

The supported production store is one SQLite file and one writer. A replica must not accept writes until promoted. A future replicated or Postgres store needs a store interface around the methods currently called directly by the app: event append/read/list/verify, artifacts, actors and sessions, read scopes/groups, knowledge log, gateway receipts, integrations/outbox, and backup/export/import. `core/store.js` is not yet that interface, so switching databases is future work, not a configuration setting.
