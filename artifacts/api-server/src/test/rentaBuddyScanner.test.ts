/**
 * rentaBuddyScanner.test.ts — pure unit tests for the Rent a Buddy keyword
 * policy scanner.
 *
 * No DB, no Express server, no fake client. scanText() is a pure function that
 * takes a string and returns PolicyMatch[].
 *
 * Run: node --import tsx/esm --test src/test/rentaBuddyScanner.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scanText,
  worstSeverity,
  isPrivateLocation,
  getCategoryRiskLevel,
} from "../lib/rentaBuddyScanner.js";

// ── scanText — critical violations ────────────────────────────────────────────

describe("scanText — adult_service (critical)", () => {
  it("detects 'escort' keyword", () => {
    const matches = scanText("I offer escort services in the city");
    assert.equal(matches.length > 0, true);
    const hit = matches.find((m) => m.category === "adult_service");
    assert.ok(hit, "expected adult_service match");
    assert.equal(hit!.severity, "critical");
  });

  it("detects 'girlfriend experience'", () => {
    const matches = scanText("Looking for a girlfriend experience tonight");
    const hit = matches.find((m) => m.category === "adult_service");
    assert.ok(hit, "expected adult_service match");
    assert.equal(hit!.severity, "critical");
  });

  it("detects 'sex work' phrase", () => {
    const matches = scanText("I provide sex work services");
    const hit = matches.find((m) => m.category === "adult_service");
    assert.ok(hit, "expected adult_service match");
    assert.equal(hit!.severity, "critical");
  });

  it("detects 'prostitut' prefix", () => {
    const matches = scanText("prostitution services available");
    const hit = matches.find((m) => m.category === "adult_service");
    assert.ok(hit);
    assert.equal(hit!.severity, "critical");
  });
});

describe("scanText — weapons (critical)", () => {
  it("detects firearm reference", () => {
    const matches = scanText("I will bring a gun for protection");
    const hit = matches.find((m) => m.category === "weapons");
    assert.ok(hit);
    assert.equal(hit!.severity, "critical");
  });
});

describe("scanText — off_app_payment (high)", () => {
  it("detects 'off-app' payment solicitation", () => {
    const matches = scanText("Please pay off-app to save on fees");
    const hit = matches.find((m) => m.category === "off_app_payment");
    assert.ok(hit, "expected off_app_payment match");
    assert.equal(hit!.severity, "high");
  });

  it("detects 'venmo me'", () => {
    const matches = scanText("Just venmo me instead");
    const hit = matches.find((m) => m.category === "off_app_payment");
    assert.ok(hit);
    assert.equal(hit!.severity, "high");
  });
});

describe("scanText — drugs (high)", () => {
  it("detects drug reference", () => {
    const matches = scanText("I can help you find weed");
    const hit = matches.find((m) => m.category === "drugs");
    assert.ok(hit);
    assert.equal(hit!.severity, "high");
  });

  it("does not flag 'drug store' (false-positive guard)", () => {
    const matches = scanText("Meet me at the drug store on Main St");
    const hit = matches.find((m) => m.category === "drugs");
    assert.equal(hit, undefined, "drug store should NOT be flagged");
  });
});

describe("scanText — massage_service (medium)", () => {
  it("detects massage reference at medium severity", () => {
    const matches = scanText("I offer relaxing massage sessions");
    const hit = matches.find((m) => m.category === "massage_service");
    assert.ok(hit);
    assert.equal(hit!.severity, "medium");
  });

  it("escalates happy ending to adult_massage at critical", () => {
    const matches = scanText("massage with happy ending available");
    const hit = matches.find((m) => m.category === "adult_massage");
    assert.ok(hit);
    assert.equal(hit!.severity, "critical");
  });
});

describe("scanText — clean text returns no matches", () => {
  it("city guide bio clears the scanner", () => {
    const matches = scanText(
      "I am a local guide in Manila. I love showing visitors hidden gems, " +
      "local markets, and historic sites. Fluent in English and Tagalog.",
    );
    assert.equal(matches.length, 0);
  });

  it("nightlife guide text clears the scanner", () => {
    const matches = scanText(
      "Nightlife expert — best rooftop bars, live music spots, and club scene around BGC.",
    );
    assert.equal(matches.length, 0);
  });
});

describe("scanText — multiple violations, one match per category", () => {
  it("returns one match per category even if multiple patterns hit", () => {
    const matches = scanText("escort and girlfriend experience available");
    const adultHits = matches.filter((m) => m.category === "adult_service");
    assert.equal(adultHits.length, 1, "only one match per category");
  });
});

// ── worstSeverity ─────────────────────────────────────────────────────────────

describe("worstSeverity", () => {
  it("returns null for empty array", () => {
    assert.equal(worstSeverity([]), null);
  });

  it("picks critical over high", () => {
    const matches = [
      { category: "off_app_payment", severity: "high" as const, excerpt: "" },
      { category: "adult_service", severity: "critical" as const, excerpt: "" },
    ];
    const worst = worstSeverity(matches);
    assert.equal(worst?.severity, "critical");
    assert.equal(worst?.category, "adult_service");
  });

  it("picks high over medium", () => {
    const matches = [
      { category: "massage_service", severity: "medium" as const, excerpt: "" },
      { category: "drugs", severity: "high" as const, excerpt: "" },
    ];
    const worst = worstSeverity(matches);
    assert.equal(worst?.severity, "high");
  });
});

// ── isPrivateLocation ─────────────────────────────────────────────────────────

describe("isPrivateLocation", () => {
  it("flags 'my room'", () => {
    assert.equal(isPrivateLocation("Meet me in my room"), true);
  });

  it("flags 'my place'", () => {
    assert.equal(isPrivateLocation("Come over to my place"), true);
  });

  it("flags 'hotel room'", () => {
    assert.equal(isPrivateLocation("Let's meet at my hotel room"), true);
  });

  it("clears public venue text", () => {
    assert.equal(isPrivateLocation("Meet me at the lobby of Ayala Mall"), false);
  });
});

// ── getCategoryRiskLevel ──────────────────────────────────────────────────────

describe("getCategoryRiskLevel", () => {
  it("arrival is high risk", () => {
    assert.equal(getCategoryRiskLevel("arrival"), "high");
  });

  it("nightlife is high risk", () => {
    assert.equal(getCategoryRiskLevel("nightlife"), "high");
  });

  it("city is low risk", () => {
    assert.equal(getCategoryRiskLevel("city"), "low");
  });

  it("unknown category defaults to low", () => {
    assert.equal(getCategoryRiskLevel("unknown_category"), "low");
  });
});
