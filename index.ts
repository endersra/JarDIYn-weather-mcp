#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = process.env.JARDIYN_USER_AGENT ?? "jardiyn-garden-hub/1.0";

const ZONE_MIN_HARDINESS: Record<string, number> = {
  mango: 10,
  banana: 9,
  citrus: 9,
  tomato: 2,
  lavender: 5,
  blueberry: 3
};

const ACID_LOVING_PLANTS = ["blueberry", "azalea", "rhododendron"];
const INVASIVE_KEYWORDS = [
  "kudzu",
  "knotweed",
  "english ivy",
  "purple loosestrife",
  "garlic mustard",
  "climbing aggressively",
  "spreading vine",
  "fast-spreading vine"
];

const DEMO_PROFILE = {
  profile_id: "demo-grand-rapids",
  owner: "Sarah (novice homeowner)",
  zone: "6a",
  last_spring_frost: "2026-05-05",
  first_fall_frost: "2026-10-15",
  soil_type: "loam",
  soil_ph: 6.7,
  sun_exposure: "full sun",
  garden_size_sqft: 800,
  existing_plants: ["tomato", "basil", "lavender"],
  goals: ["pollinator friendly", "low water"]
};

const GardenProfileSchema = z.object({
  profile_id: z.string().optional().describe("Garden profile id, if available"),
  owner: z.string().optional().describe("Human-readable profile owner/name"),
  zone: z.string().describe("USDA hardiness zone, for example 6a"),
  last_spring_frost: z.string().optional().describe("Last spring frost date as YYYY-MM-DD"),
  first_fall_frost: z.string().optional().describe("First fall frost date as YYYY-MM-DD"),
  soil_type: z.string().default("loam").describe("Soil type such as clay, loam, sandy, or silt"),
  soil_ph: z.number().optional().describe("Soil pH, if known"),
  sun_exposure: z.string().default("full sun").describe("Sun exposure such as full sun, partial shade, or shade"),
  garden_size_sqft: z.number().optional().describe("Garden size in square feet"),
  existing_plants: z.array(z.string()).default([]).describe("Existing plants in the garden"),
  goals: z.array(z.string()).default([]).describe("Gardener goals such as pollinator friendly or blueberries")
});

const GardenObservationSchema = z.object({
  type: z.string().optional().describe("Observation type such as watering_log, photo_scan, design_request, or calendar_request"),
  subject: z.string().optional().describe("Observed subject, such as tomato leaf or fast-spreading vine"),
  note: z.string().optional().describe("Free-text observation note"),
  requested_plant: z.string().optional().describe("Plant requested by the user, for example mango or blueberry"),
  planting_date: z.string().optional().describe("Planned planting date as YYYY-MM-DD")
});

type GardenProfile = z.infer<typeof GardenProfileSchema>;
type GardenObservation = z.infer<typeof GardenObservationSchema>;

type Recommendation = {
  signal: string;
  severity: "minor" | "major" | "critical";
  message: string;
  trigger: string;
};

type PointsResponse = {
  properties?: {
    forecast?: string;
    forecastHourly?: string;
    relativeLocation?: {
      properties?: {
        city?: string;
        state?: string;
      };
    };
  };
};

type ForecastPeriod = {
  name?: string;
  isDaytime?: boolean;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
  detailedForecast?: string;
  probabilityOfPrecipitation?: {
    value?: number | null;
  };
  relativeHumidity?: {
    value?: number | null;
  };
};

type ForecastResponse = {
  properties?: {
    periods?: ForecastPeriod[];
  };
};

type AlertFeature = {
  properties?: {
    event?: string;
    areaDesc?: string;
    severity?: string;
    status?: string;
    headline?: string;
    description?: string;
    instruction?: string;
  };
};

type AlertsResponse = {
  features?: AlertFeature[];
};

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }]
  };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

async function nwsFetch<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/geo+json"
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`NWS request failed (${response.status} ${response.statusText}) for ${url}${body ? `: ${body}` : ""}`);
  }

  return (await response.json()) as T;
}

function zoneNumber(zone: string | undefined): number | null {
  const match = String(zone ?? "").match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function monthOf(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  return Number.isNaN(date.getTime()) ? null : date.getMonth() + 1;
}

function evaluateGarden(profile: GardenProfile, observation: GardenObservation = {}): Recommendation[] {
  const recs: Recommendation[] = [];
  const requested = (observation.requested_plant ?? "").toLowerCase();

  if (requested && ZONE_MIN_HARDINESS[requested] != null) {
    const zn = zoneNumber(profile.zone);
    const minimumZone = ZONE_MIN_HARDINESS[requested];

    if (zn != null && zn < minimumZone) {
      recs.push({
        signal: "zone_mismatch_plant",
        severity: "major",
        message: `${requested} needs USDA Zone ${minimumZone}+ but this garden is Zone ${profile.zone}. Choose a cold-hardy alternative instead.`,
        trigger: `requested_plant=${requested}, profile.zone=${profile.zone}`
      });
    }
  }

  if ((profile.soil_type ?? "").toLowerCase() === "clay") {
    recs.push({
      signal: "clay_soil_drainage",
      severity: "major",
      message: "Clay soil drains poorly. Amend with grit and compost, or use a rain garden for moisture-loving plants.",
      trigger: `profile.soil_type=${profile.soil_type}`
    });
  }

  const note = (observation.note ?? "").toLowerCase();

  if (/3 times per day|3x daily|three times a day|3x/.test(note)) {
    recs.push({
      signal: "overwatering_pattern",
      severity: "major",
      message: "Watering 3x daily is overwatering and risks root rot. Most plants need about 1-1.5 inches of water per week.",
      trigger: `observation.note="${observation.note ?? ""}"`
    });
  }

  const subject = (observation.subject ?? "").toLowerCase();
  if (INVASIVE_KEYWORDS.some(keyword => note.includes(keyword) || subject.includes(keyword))) {
    recs.push({
      signal: "invasive_species_photo",
      severity: "critical",
      message: "This looks like an invasive species. Remove it promptly: cut back growth, dig out roots/rhizomes, and dispose of it in the trash, not compost.",
      trigger: `observation.subject="${observation.subject ?? ""}", note="${observation.note ?? ""}"`
    });
  }

  const goalsAndPlants = [...(profile.goals ?? []), ...(profile.existing_plants ?? [])].join(" ").toLowerCase();
  const wantsAcidPlant = ACID_LOVING_PLANTS.some(plant => requested.includes(plant) || goalsAndPlants.includes(plant));

  if (wantsAcidPlant && profile.soil_ph != null && profile.soil_ph > 6.0) {
    recs.push({
      signal: "ph_imbalance_blueberry",
      severity: "major",
      message: `Blueberries and other acid-loving plants need soil pH 4.5-5.5, but this soil is pH ${profile.soil_ph}. Add elemental sulfur or use a raised bed with peat moss.`,
      trigger: `acid-loving plant requested, profile.soil_ph=${profile.soil_ph}`
    });
  }

  const plantMonth = monthOf(observation.planting_date);
  const frostMonth = monthOf(profile.last_spring_frost);
  if (plantMonth != null && frostMonth != null && plantMonth < frostMonth) {
    recs.push({
      signal: "frost_date_violation",
      severity: "major",
      message: `Planting on ${observation.planting_date} is before the last spring frost (${profile.last_spring_frost}). Frost-tender crops risk damage. Wait until after the last frost date.`,
      trigger: `planting_date=${observation.planting_date}, last_spring_frost=${profile.last_spring_frost}`
    });
  }

  return recs;
}

async function getPointForecast(latitude: number, longitude: number): Promise<{ location: string; periods: ForecastPeriod[] }> {
  const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  const points = await nwsFetch<PointsResponse>(pointsUrl);
  const forecastUrl = points.properties?.forecast;

  if (!forecastUrl) {
    throw new Error("NWS did not return a forecast URL for that point. The point may be outside the United States or a supported NWS region.");
  }

  const forecast = await nwsFetch<ForecastResponse>(forecastUrl);
  const periods = forecast.properties?.periods ?? [];
  const city = points.properties?.relativeLocation?.properties?.city;
  const state = points.properties?.relativeLocation?.properties?.state;
  const location = [city, state].filter(Boolean).join(", ") || `${latitude}, ${longitude}`;

  return { location, periods };
}

function formatForecast(location: string, periods: ForecastPeriod[], limit = 5): string {
  if (periods.length === 0) {
    return `No forecast periods were returned for ${location}.`;
  }

  return periods.slice(0, limit).map(period => {
    const pop = period.probabilityOfPrecipitation?.value;
    const precip = typeof pop === "number" ? `\nPrecipitation chance: ${pop}%` : "";
    return [
      `### ${period.name ?? "Forecast period"} — ${location}`,
      `Temperature: ${period.temperature ?? "unknown"}°${period.temperatureUnit ?? "F"}`,
      `Wind: ${period.windSpeed ?? "unknown"} ${period.windDirection ?? ""}`.trim(),
      `Summary: ${period.shortForecast ?? "No short forecast available"}`,
      period.detailedForecast ? `Details: ${period.detailedForecast}` : undefined,
      precip || undefined
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function formatAlerts(state: string, features: AlertFeature[]): string {
  if (features.length === 0) {
    return `No active NWS alerts for ${state}.`;
  }

  return features.map(feature => {
    const properties = feature.properties ?? {};
    return [
      `### ${properties.event ?? "Weather alert"}`,
      properties.headline ? `Headline: ${properties.headline}` : undefined,
      properties.areaDesc ? `Area: ${properties.areaDesc}` : undefined,
      properties.severity ? `Severity: ${properties.severity}` : undefined,
      properties.status ? `Status: ${properties.status}` : undefined,
      properties.description ? `Description: ${properties.description}` : undefined,
      properties.instruction ? `Instruction: ${properties.instruction}` : undefined
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function hasRainSignal(period: ForecastPeriod): boolean {
  const pop = period.probabilityOfPrecipitation?.value ?? 0;
  const text = `${period.shortForecast ?? ""} ${period.detailedForecast ?? ""}`.toLowerCase();
  return pop >= 50 || /rain|showers|thunderstorm|drizzle/.test(text);
}

function buildWateringPlan(profile: Partial<GardenProfile>, periods: ForecastPeriod[]) {
  const reviewed = periods.slice(0, 6);
  const soil = (profile.soil_type ?? "loam").toLowerCase();
  const sun = (profile.sun_exposure ?? "full sun").toLowerCase();
  const rainLikely = reviewed.some(hasRainSignal);
  const hot = reviewed.some(period => period.isDaytime !== false && typeof period.temperature === "number" && period.temperature >= 85);
  const maxPop = Math.max(0, ...reviewed.map(period => period.probabilityOfPrecipitation?.value ?? 0));

  const reasons: string[] = [];
  if (rainLikely) reasons.push(`Forecast includes likely rain or showers; max precipitation chance reviewed is ${maxPop}%.`);
  if (hot) reasons.push("Forecast includes daytime heat at or above 85°F, which can increase evaporation and plant stress.");
  if (soil.includes("clay")) reasons.push("Clay soil holds water longer and is more prone to root rot if watered too often.");
  if (soil.includes("sand")) reasons.push("Sandy soil drains quickly and may need smaller, more frequent watering.");
  if (sun.includes("full")) reasons.push("Full sun increases water demand compared with shade.");

  let recommendation: string;
  let cadence: string;

  if (rainLikely) {
    recommendation = "Pause irrigation before the rain window, then check soil moisture 2 inches down after the system passes. Water only if that depth is dry.";
    cadence = "Re-check after forecast rain; avoid automatic daily watering.";
  } else if (soil.includes("clay")) {
    recommendation = "Water deeply only when the top 2-3 inches are dry. For clay, one slow soak is safer than frequent shallow watering.";
    cadence = hot ? "Check every 2 days during heat; otherwise check twice weekly." : "Check twice weekly.";
  } else if (soil.includes("sand")) {
    recommendation = "Use shorter watering sessions so water does not run through the root zone. Mulch to reduce evaporation.";
    cadence = hot ? "Check daily during heat; otherwise every 2-3 days." : "Check every 2-3 days.";
  } else {
    recommendation = "Aim for about 1-1.5 inches of water per week, including rainfall. Water early in the morning at soil level.";
    cadence = hot ? "Check every 1-2 days during heat; otherwise twice weekly." : "Check twice weekly.";
  }

  return {
    recommendation,
    cadence,
    reasons,
    forecast_periods_reviewed: reviewed.map(period => ({
      name: period.name,
      temperature: period.temperature,
      temperatureUnit: period.temperatureUnit,
      precipitationChance: period.probabilityOfPrecipitation?.value ?? null,
      shortForecast: period.shortForecast
    }))
  };
}

const server = new McpServer({
  name: "jardiyn-weather-mcp",
  version: "1.0.0"
});

server.registerResource(
  "jardiyn-project-context",
  "jardiyn://project/context",
  {
    title: "JarDIYn Project Context",
    description: "Static project context for JarDIYn by GardenHub",
    mimeType: "text/markdown"
  },
  async uri => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: `# JarDIYn by GardenHub\n\nAgentic garden intelligence platform for zone-accurate, organic-first landscaping recommendations.\n\nRepository: https://github.com/endersra/jardiyn-garden-hub\nDemo: https://endersra.github.io/jardiyn-garden-hub/jardiyn-final-submission/src/\n\nThe v25 app is a static mock-mode prototype. This MCP server adds local AI-agent tools for NWS weather, watering schedules, and deterministic garden-signal checks.`
    }]
  })
);

server.registerTool(
  "get_demo_garden_profile",
  {
    title: "Get Demo Garden Profile",
    description: "Return the JarDIYn demo Grand Rapids garden profile used by the static app.",
    inputSchema: {}
  },
  async () => jsonResult(DEMO_PROFILE)
);

server.registerTool(
  "evaluate_garden_signals",
  {
    title: "Evaluate Garden Signals",
    description: "Run JarDIYn's deterministic-first rules for zone mismatch, clay drainage, overwatering, invasive species, pH imbalance, and frost-date violations.",
    inputSchema: {
      profile: GardenProfileSchema,
      observation: GardenObservationSchema.optional()
    }
  },
  async ({ profile, observation }) => {
    const recommendations = evaluateGarden(profile, observation ?? {});
    return jsonResult({
      detected_signals: recommendations.map(rec => rec.signal),
      recommendations,
      recommendation_count: recommendations.length
    });
  }
);

server.registerTool(
  "get_forecast",
  {
    title: "Get NWS Forecast",
    description: "Get a National Weather Service forecast for a US latitude/longitude. Useful for garden planning and watering decisions.",
    inputSchema: {
      latitude: z.number().min(-90).max(90).describe("Latitude, for example 42.9634 for Grand Rapids, MI"),
      longitude: z.number().min(-180).max(180).describe("Longitude, for example -85.6681 for Grand Rapids, MI"),
      periods: z.number().int().min(1).max(14).default(5).describe("Number of forecast periods to return")
    }
  },
  async ({ latitude, longitude, periods }) => {
    try {
      const forecast = await getPointForecast(latitude, longitude);
      return textResult(formatForecast(forecast.location, forecast.periods, periods));
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true
      };
    }
  }
);

server.registerTool(
  "get_weather_alerts",
  {
    title: "Get NWS Weather Alerts",
    description: "Get active National Weather Service alerts for a two-letter US state code.",
    inputSchema: {
      state: z.string().length(2).describe("Two-letter state code, for example MI")
    }
  },
  async ({ state }) => {
    const stateCode = state.toUpperCase();

    try {
      const alerts = await nwsFetch<AlertsResponse>(`${NWS_API_BASE}/alerts/active?area=${stateCode}`);
      return textResult(formatAlerts(stateCode, alerts.features ?? []));
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true
      };
    }
  }
);

server.registerTool(
  "create_watering_schedule",
  {
    title: "Create Weather-Aware Watering Schedule",
    description: "Use NWS forecast plus JarDIYn garden profile details to create an organic-first watering recommendation.",
    inputSchema: {
      latitude: z.number().min(-90).max(90).describe("Garden latitude"),
      longitude: z.number().min(-180).max(180).describe("Garden longitude"),
      profile: GardenProfileSchema.partial().optional().describe("Known garden profile fields such as soil_type, sun_exposure, and zone")
    }
  },
  async ({ latitude, longitude, profile }) => {
    try {
      const forecast = await getPointForecast(latitude, longitude);
      const plan = buildWateringPlan(profile ?? {}, forecast.periods);
      return jsonResult({
        location: forecast.location,
        generated_at: new Date().toISOString(),
        profile_used: profile ?? {},
        ...plan
      });
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true
      };
    }
  }
);

server.registerPrompt(
  "garden-design-copilot",
  {
    title: "Garden Design Copilot Prompt",
    description: "Prompt template aligned with JarDIYn's deterministic-first, organic-first garden design approach.",
    argsSchema: {
      userRequest: z.string().describe("The user's garden design request"),
      zone: z.string().default("6a").describe("USDA hardiness zone"),
      soilType: z.string().default("loam").describe("Soil type"),
      sunExposure: z.string().default("full sun").describe("Sun exposure")
    }
  },
  async ({ userRequest, zone, soilType, sunExposure }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Act as JarDIYn's garden design copilot. Use deterministic checks first, then write a concise narrative.\n\nGarden context:\n- USDA zone: ${zone}\n- Soil: ${soilType}\n- Sun: ${sunExposure}\n\nUser request:\n${userRequest}\n\nReturn: warnings/signals first, then a zone-correct plant palette, spacing, layout rationale, and organic maintenance notes.`
      }
    }]
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error("JarDIYn MCP server failed to start:", error);
  process.exit(1);
});
