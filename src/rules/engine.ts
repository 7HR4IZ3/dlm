import { DEFAULT_POSTPROCESS_PLAN } from "../domain/defaults";
import type {
  AddDownloadInput,
  AuthProfile,
  PostProcessPlan,
  Ruleset,
  RulesetAction,
  RulesetMatcher,
} from "../domain/types";

export interface RuleContext {
  url: string;
  host: string;
  mimeType?: string | null;
  fileName?: string | null;
  totalBytes?: number | null;
  tags: string[];
}

export interface ResolvedRules {
  matchedRulesets: Ruleset[];
  destinationDir?: string;
  category?: string;
  filenameTemplate?: string;
  maxSegments?: number;
  rateLimitBytesPerSec?: number;
  retryPolicy?: string;
  scheduleWindow?: string;
  authProfileId?: string;
  postprocess: PostProcessPlan;
}

export function resolveRules(
  input: AddDownloadInput,
  context: RuleContext,
  rulesets: Ruleset[],
  authProfiles: AuthProfile[],
): ResolvedRules {
  const enabled = rulesets.filter((ruleset) => ruleset.enabled).sort((a, b) => a.priority - b.priority);
  const matchedRulesets = enabled.filter((ruleset) => ruleset.matchers.every((matcher) => matchRule(matcher, context)));

  const resolved: ResolvedRules = {
    matchedRulesets,
    postprocess: { ...DEFAULT_POSTPROCESS_PLAN, ...input.postprocess },
  };

  for (const ruleset of matchedRulesets) {
    for (const action of ruleset.actions) {
      applyAction(resolved, action);
    }
  }

  if (input.rulesetId) {
    const explicit = enabled.find((ruleset) => ruleset.id === input.rulesetId);
    if (explicit) {
      resolved.matchedRulesets.push(explicit);
      for (const action of explicit.actions) {
        applyAction(resolved, action);
      }
    }
  }

  if (input.maxSegments != null) {
    resolved.maxSegments = input.maxSegments;
  }
  if (input.rateLimitBytesPerSec != null) {
    resolved.rateLimitBytesPerSec = input.rateLimitBytesPerSec;
  }
  if (input.authProfileId) {
    resolved.authProfileId = input.authProfileId;
  }

  if (resolved.authProfileId && !authProfiles.some((profile) => profile.id === resolved.authProfileId)) {
    delete resolved.authProfileId;
  }

  return resolved;
}

export function matchRule(matcher: RulesetMatcher, context: RuleContext): boolean {
  switch (matcher.type) {
    case "host":
      return context.host === matcher.value;
    case "url_glob":
      return globMatch(matcher.value, context.url);
    case "url_regex":
      return new RegExp(matcher.value).test(context.url);
    case "mime":
      return context.mimeType?.toLowerCase() === matcher.value.toLowerCase();
    case "extension":
      return context.fileName?.toLowerCase().endsWith(matcher.value.toLowerCase()) ?? false;
    case "min_size":
      return (context.totalBytes ?? -Infinity) >= matcher.value;
    case "max_size":
      return (context.totalBytes ?? Infinity) <= matcher.value;
    case "tag":
      return context.tags.includes(matcher.value);
    default:
      return false;
  }
}

export function isWithinSchedule(windowValue: string | null, now = new Date()): boolean {
  if (!windowValue || windowValue === "always") {
    return true;
  }

  const [daysPart, timePartRaw] = windowValue.includes("@")
    ? windowValue.split("@")
    : ["daily", windowValue];
  const timePart = timePartRaw ?? "00:00-23:59";
  const [start, end] = timePart.split("-");
  if (!start || !end) {
    return true;
  }

  const currentDay = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  if (!matchDay(daysPart, currentDay)) {
    return false;
  }

  const startMinutes = parseClock(start);
  const endMinutes = parseClock(end);
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

function applyAction(target: ResolvedRules, action: RulesetAction): void {
  switch (action.type) {
    case "set_destination_dir":
      target.destinationDir = action.value;
      break;
    case "set_category":
      target.category = action.value;
      break;
    case "set_filename_template":
      target.filenameTemplate = action.value;
      break;
    case "set_max_segments":
      target.maxSegments = action.value;
      break;
    case "set_rate_limit":
      target.rateLimitBytesPerSec = action.value;
      break;
    case "set_retry_policy":
      target.retryPolicy = action.value;
      break;
    case "set_schedule_window":
      target.scheduleWindow = action.value;
      break;
    case "set_auth_profile":
      target.authProfileId = action.value;
      break;
    case "toggle_postprocess":
      target.postprocess[action.step] = action.enabled;
      break;
  }
}

function matchDay(daySpec: string, currentDay: number): boolean {
  if (daySpec === "daily" || daySpec === "always") {
    return true;
  }
  if (daySpec === "weekdays") {
    return currentDay >= 1 && currentDay <= 5;
  }
  if (daySpec === "weekends") {
    return currentDay === 0 || currentDay === 6;
  }
  const tokens = daySpec.split(",").map((token) => token.trim().toLowerCase());
  const mapping = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return tokens.includes(mapping[currentDay]!);
}

function parseClock(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

