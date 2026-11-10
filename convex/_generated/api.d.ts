/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as Availabilityrecommender from "../Availabilityrecommender.js";
import type * as accounting from "../accounting.js";
import type * as aiAssistant from "../aiAssistant.js";
import type * as anouncements from "../anouncements.js";
import type * as assets from "../assets.js";
import type * as auditlogs from "../auditlogs.js";
import type * as dashboard from "../dashboard.js";
import type * as dateutils from "../dateutils.js";
import type * as debugSchema from "../debugSchema.js";
import type * as electricity from "../electricity.js";
import type * as exiteb from "../exiteb.js";
import type * as http from "../http.js";
import type * as lib_sms from "../lib/sms.js";
import type * as lib_supabaseAdmin from "../lib/supabaseAdmin.js";
import type * as market from "../market.js";
import type * as metrics from "../metrics.js";
import type * as notifications from "../notifications.js";
import type * as otpAuth from "../otpAuth.js";
import type * as owners from "../owners.js";
import type * as properties from "../properties.js";
import type * as reports from "../reports.js";
import type * as runAIDiagnosis from "../runAIDiagnosis.js";
import type * as screencache from "../screencache.js";
import type * as settings from "../settings.js";
import type * as tabpermission from "../tabpermission.js";
import type * as tenants from "../tenants.js";
import type * as tenantsextraactions from "../tenantsextraactions.js";
import type * as tickets from "../tickets.js";
import type * as voiceIntentRouter from "../voiceIntentRouter.js";
import type * as voiceProcessor from "../voiceProcessor.js";
import type * as voiceTicket from "../voiceTicket.js";
import type * as whatsapplogs from "../whatsapplogs.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  Availabilityrecommender: typeof Availabilityrecommender;
  accounting: typeof accounting;
  aiAssistant: typeof aiAssistant;
  anouncements: typeof anouncements;
  assets: typeof assets;
  auditlogs: typeof auditlogs;
  dashboard: typeof dashboard;
  dateutils: typeof dateutils;
  debugSchema: typeof debugSchema;
  electricity: typeof electricity;
  exiteb: typeof exiteb;
  http: typeof http;
  "lib/sms": typeof lib_sms;
  "lib/supabaseAdmin": typeof lib_supabaseAdmin;
  market: typeof market;
  metrics: typeof metrics;
  notifications: typeof notifications;
  otpAuth: typeof otpAuth;
  owners: typeof owners;
  properties: typeof properties;
  reports: typeof reports;
  runAIDiagnosis: typeof runAIDiagnosis;
  screencache: typeof screencache;
  settings: typeof settings;
  tabpermission: typeof tabpermission;
  tenants: typeof tenants;
  tenantsextraactions: typeof tenantsextraactions;
  tickets: typeof tickets;
  voiceIntentRouter: typeof voiceIntentRouter;
  voiceProcessor: typeof voiceProcessor;
  voiceTicket: typeof voiceTicket;
  whatsapplogs: typeof whatsapplogs;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
