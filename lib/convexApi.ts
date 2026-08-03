/**
 * Convex HTTP client for calling backend actions from plain JS modules.
 * Used by supabaseService.ts to route all operations through Convex → Supabase.
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const CONVEX_URL = "https://wonderful-kiwi-122.convex.cloud";

const client = new ConvexHttpClient(CONVEX_URL);

export { client, api };
