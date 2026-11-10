/**
 * Convex HTTP client for calling backend actions from plain JS modules.
 * Used by supabaseService.ts to route all operations through Convex → Supabase.
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { CONVEX_CLOUD_URL } from "./config";

const CONVEX_URL = CONVEX_CLOUD_URL;

const client = new ConvexHttpClient(CONVEX_URL);

export { client, api };
