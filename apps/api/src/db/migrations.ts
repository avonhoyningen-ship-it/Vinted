/**
 * Plain-SQL migrations (kept portable so a later switch to PostgreSQL is a
 * mostly mechanical change). Money is stored as integer cents, timestamps as
 * ISO-8601 UTC strings.
 */
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export const migrations: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "init",
    sql: `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,                       -- e.g. vinted.de
  username TEXT,
  vinted_user_id TEXT,
  session_encrypted TEXT,                     -- AES-256-GCM, never plaintext
  session_hint TEXT,                          -- masked (last 4 chars) for UI
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','connected','error','disconnected')),
  last_error TEXT,
  last_sync_at TEXT,
  followers INTEGER NOT NULL DEFAULT 0,
  active_listings INTEGER NOT NULL DEFAULT 0,
  total_sales INTEGER NOT NULL DEFAULT 0,
  unread_messages INTEGER NOT NULL DEFAULT 0,
  publish_interval_minutes INTEGER,           -- overrides PUBLISH_INTERVAL_MINUTES
  polling_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);

-- Archive master record: one row per physical article, never deleted by sync.
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT,
  brand TEXT,
  size TEXT,
  condition TEXT,                             -- new_with_tags, new, very_good, good, satisfactory
  color TEXT,
  material TEXT,
  measurements TEXT,                          -- free text, e.g. "Länge 70 cm, Achsel 52 cm"
  price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'EUR',
  purchase_price_cents INTEGER,               -- optional: for profit stats
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','queued','active','sold','archived','relisted')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_brand ON items(brand);
CREATE INDEX idx_items_category ON items(category);

CREATE TABLE item_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,                    -- relative to STORAGE_DIR
  original_name TEXT,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER,
  sha256 TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_item_photos_item ON item_photos(item_id, position);

-- Every time an item is put on a Vinted account = one listing (history).
CREATE TABLE listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  vinted_item_id TEXT,
  url TEXT,
  title TEXT NOT NULL,                        -- snapshot at publish time
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'EUR',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','sold','removed','expired','hidden')),
  favourites INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  listed_at TEXT NOT NULL DEFAULT ${NOW},
  sold_at TEXT,
  sold_price_cents INTEGER,
  ended_at TEXT,
  last_price_drop_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (account_id, vinted_item_id)
);
CREATE INDEX idx_listings_item ON listings(item_id);
CREATE INDEX idx_listings_account_status ON listings(account_id, status);

CREATE TABLE listing_price_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  old_price_cents INTEGER,
  new_price_cents INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  listing_id INTEGER REFERENCES listings(id),
  item_id INTEGER REFERENCES items(id),
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  buyer TEXT,
  category TEXT,
  brand TEXT,
  sold_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (account_id, external_id)
);
CREATE INDEX idx_sales_sold_at ON sales(sold_at);

CREATE TABLE publish_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  listing_id INTEGER REFERENCES listings(id),
  is_reupload INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_queue_due ON publish_queue(status, scheduled_at);

CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other'
    CHECK (kind IN ('shipping','condition','measurements','other')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE automation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,   -- NULL = all accounts
  trigger_type TEXT NOT NULL
    CHECK (trigger_type IN ('item_favourited','message_received','item_sold','listing_stale')),
  trigger_config TEXT NOT NULL DEFAULT '{}',  -- JSON: keywords, days, ...
  action_type TEXT NOT NULL
    CHECK (action_type IN ('send_message','reduce_price')),
  action_config TEXT NOT NULL DEFAULT '{}',   -- JSON: message, percent, min price, ...
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  per_user_limit INTEGER NOT NULL DEFAULT 1,
  per_user_window_hours INTEGER NOT NULL DEFAULT 168,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);

-- Raw events observed while polling (deduplicated).
CREATE TABLE vinted_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  listing_id INTEGER REFERENCES listings(id),
  vinted_user_id TEXT,
  vinted_username TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (account_id, type, external_id)
);

CREATE TABLE scheduled_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER REFERENCES automation_rules(id) ON DELETE SET NULL,
  event_id INTEGER REFERENCES vinted_events(id) ON DELETE SET NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id INTEGER REFERENCES listings(id),
  action_type TEXT NOT NULL,
  target_user_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','done','failed','skipped','cancelled')),
  result TEXT,
  executed_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_actions_due ON scheduled_actions(status, run_at);
CREATE INDEX idx_actions_limit ON scheduled_actions(rule_id, target_user_id, created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];
