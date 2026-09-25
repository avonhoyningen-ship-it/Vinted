export interface Account {
  id: number; name: string; domain: string; username: string | null; vinted_user_id: string | null;
  session_hint: string | null; has_session: boolean; has_refresh_token: boolean; status: string; last_error: string | null; last_sync_at: string | null;
  followers: number; active_listings: number; total_sales: number; unread_messages: number;
  publish_interval_minutes: number | null; polling_enabled: boolean; created_at: string;
}

export interface Item {
  id: number; title: string; description: string; category: string | null; brand: string | null; size: string | null;
  condition: string | null; color: string | null; material: string | null; measurements: string | null;
  price_cents: number | null; currency: string; purchase_price_cents: number | null; status: string; notes: string | null;
  price_suggested_cents: number | null; price_suggestion_reason: string | null; price_confirmed: number;
  created_at: string; updated_at: string;
  cover_photo?: string | null; photo_count?: number; times_listed?: number; last_account?: string | null;
}

export interface Photo { id: number; item_id: number; file_name: string; original_name: string | null; width: number | null; height: number | null; position: number }

export interface Listing {
  id: number; item_id: number; account_id: number; vinted_item_id: string | null; url: string | null; title: string;
  description: string; price_cents: number | null; currency: string; status: string; favourites: number; views: number;
  listed_at: string; sold_at: string | null; sold_price_cents: number | null; ended_at: string | null;
  account_name?: string; cover_photo?: string | null; days_online?: number;
}

export interface QueueEntry {
  id: number; item_id: number; account_id: number; scheduled_at: string; status: string; attempts: number;
  last_error: string | null; is_reupload: number; title: string; price_cents: number | null; currency: string;
  account_name: string; cover_photo: string | null;
}

export interface Template { id: number; name: string; kind: string; body: string }

export interface Suggestion {
  title: string; description: string; bullets: string[]; hashtags: string[]; category: string; brand: string | null; size: string | null; condition: string;
  color: string | null; material: string | null; suggested_price_eur: number; price_reasoning: string; confidence_notes: string;
}

export interface PriceRule { id: number; brand: string | null; category: string | null; keyword: string | null; price_cents: number; note: string | null }
export interface PriceExample {
  id: number; item_id: number | null; source: "confirmed" | "bulk" | "manual" | "sold"; title: string; brand: string | null;
  category: string | null; size: string | null; condition: string | null; price_cents: number; created_at: string;
}
