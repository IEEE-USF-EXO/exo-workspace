import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";

export const supabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      storage: window.localStorage,
      autoRefreshToken: true,
    },
  },
);
