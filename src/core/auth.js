import { supabase } from "./supabase.js";

export async function readAuthState() {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();
  if (error) throw error;
  if (!session) return { session: null, member: null, isAdmin: false };

  const metadata = session.user.user_metadata || {};
  const { error: upsertError } = await supabase.from("members").upsert(
    {
      user_id: session.user.id,
      display_name:
        metadata.user_name ||
        metadata.full_name ||
        metadata.name ||
        session.user.email ||
        "",
      email: session.user.email || "",
    },
    { onConflict: "user_id" },
  );
  if (upsertError && upsertError.code !== "42P01") throw upsertError;

  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("*")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (memberError) throw memberError;

  const { data: admin, error: adminError } = await supabase
    .from("global_admins")
    .select("user_id")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (adminError && adminError.code !== "42P01") throw adminError;
  return { session, member, isAdmin: Boolean(admin) };
}

export function subscribeToAuthChanges(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => callback(session));
}
