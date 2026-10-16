export type RangeKind = "none" | "date" | "datetime";

export type CollectionSpec = {
  name: string;
  family: string;
  path: string;
  rangeKind: RangeKind;
  documentedScopes: string[];
  supportsCursor: boolean;
  supportsLatest: boolean;
  notes?: string;
};

const dashboardScopeNote =
  "Granted by the Oura developer dashboard; the public OAuth scope table does not name the exact scope string.";

const collectionDefinitions: Array<Omit<CollectionSpec, "supportsCursor" | "supportsLatest"> & Partial<Pick<CollectionSpec, "supportsCursor" | "supportsLatest">>> = [
  { name: "daily_activity", family: "daily", path: "daily_activity", rangeKind: "date", documentedScopes: ["daily"] },
  { name: "daily_cardiovascular_age", family: "heart_health", path: "daily_cardiovascular_age", rangeKind: "date", documentedScopes: [], notes: dashboardScopeNote },
  { name: "daily_readiness", family: "daily", path: "daily_readiness", rangeKind: "date", documentedScopes: ["daily"] },
  { name: "daily_resilience", family: "stress", path: "daily_resilience", rangeKind: "date", documentedScopes: [], notes: dashboardScopeNote },
  { name: "daily_sleep", family: "daily", path: "daily_sleep", rangeKind: "date", documentedScopes: ["daily"] },
  { name: "daily_spo2", family: "spo2", path: "daily_spo2", rangeKind: "date", documentedScopes: ["spo2Daily"] },
  { name: "daily_stress", family: "stress", path: "daily_stress", rangeKind: "date", documentedScopes: [], notes: dashboardScopeNote },
  { name: "enhanced_tag", family: "tag", path: "enhanced_tag", rangeKind: "date", documentedScopes: ["tag"] },
  { name: "heartrate", family: "heartrate", path: "heartrate", rangeKind: "datetime", documentedScopes: ["heartrate"], supportsLatest: true },
  { name: "personal_info", family: "personal", path: "personal_info", rangeKind: "none", documentedScopes: ["personal", "email"], supportsCursor: false },
  { name: "rest_mode_period", family: "daily", path: "rest_mode_period", rangeKind: "date", documentedScopes: ["daily"] },
  { name: "ring_battery_level", family: "ring_configuration", path: "ring_battery_level", rangeKind: "datetime", documentedScopes: [], supportsLatest: true, notes: dashboardScopeNote },
  { name: "ring_configuration", family: "ring_configuration", path: "ring_configuration", rangeKind: "none", documentedScopes: [], notes: dashboardScopeNote },
  { name: "session", family: "session", path: "session", rangeKind: "date", documentedScopes: ["session"] },
  { name: "sleep", family: "daily", path: "sleep", rangeKind: "date", documentedScopes: ["daily"] },
  { name: "sleep_time", family: "daily", path: "sleep_time", rangeKind: "date", documentedScopes: ["daily"] },
  { name: "tag", family: "tag", path: "tag", rangeKind: "date", documentedScopes: ["tag"] },
  { name: "vo2_max", family: "heart_health", path: "vO2_max", rangeKind: "date", documentedScopes: [], notes: dashboardScopeNote },
  { name: "workout", family: "workout", path: "workout", rangeKind: "date", documentedScopes: ["workout"] }
];

export const collections: CollectionSpec[] = collectionDefinitions.map((collection) => ({
  supportsCursor: true,
  supportsLatest: false,
  ...collection
}));

export const collectionNames = collections.map((collection) => collection.name) as [string, ...string[]];

export function collectionSpec(name: string): CollectionSpec {
  const collection = collections.find((candidate) => candidate.name === name);
  if (!collection) throw new Error(`Unknown Oura collection: ${name}`);
  return collection;
}

export function catalogPayload() {
  return {
    provider: "oura",
    api_version: "v2",
    collections,
    unresolved: [
      {
        name: "nighttime_movement_trace",
        status: "not_documented_as_an_api_v2_collection"
      }
    ]
  };
}
