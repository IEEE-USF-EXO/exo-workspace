// Public frontend settings copied from the existing EXO dashboard.
// Loaded before app.js; the public key is protected by database RLS policies.
// Never place a service-role key or Google OAuth client secret here.
const EXO_CONFIG = Object.freeze({
  supabaseUrl: "https://tnupwlucufewosslvcaz.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRudXB3bHVjdWZld29zc2x2Y2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NTM4MjIsImV4cCI6MjEwNzMyOTgyMn0.4TFRb6t4pE547wywotP_SWZG50NiJzlxs1_Ds51aQmM",
  authProvider: "google",
  // Folder visibility follows workspace memberships. Drive enforces actual access.
  driveRootFolder: { name: "EXO", id: "1TEs2PCaDcNQ0nlahtM9FWJKULPTjQAWM" },
  driveTeamFolders: [
    { team: "Controls", name: "Controls", id: "1Pdx0N6EHctdZKqb7P29tVHuNVr8v8yrN" },
    { team: "Electrical", name: "Electrical", id: "1WLCSZ5bMisg1GjJH-oVJhsXjM938elaR" },
    { team: "Mechanical", name: "Mechanical", id: "1sMgbFofCqB6DEapmZF6tF5tD1TZEUM76" }
  ],
  // Use this origin/path when starting OAuth; allow it in Supabase redirect settings.
  get authRedirectUrl() {
    return window.location.origin + window.location.pathname;
  }
});
